import AVFoundation
import Darwin
import Foundation
import Speech

private let protocolVersion = 1
private let maxTranscriptCharacters = 20_000
private let maxTranscriptUTF8Bytes = 192 * 1_024

private struct HelperEvent: Encodable {
    let schemaVersion: Int
    let type: String
    let text: String?
    let code: String?
    let engine: String?
    let locale: String?
    let onDevice: Bool?
    let permission: String?

    init(
        type: String,
        text: String? = nil,
        code: String? = nil,
        engine: String? = nil,
        locale: String? = nil,
        onDevice: Bool? = nil,
        permission: String? = nil
    ) {
        self.schemaVersion = protocolVersion
        self.type = type
        self.text = text
        self.code = code
        self.engine = engine
        self.locale = locale
        self.onDevice = onDevice
        self.permission = permission
    }
}

private struct HelperCommand: Decodable {
    let schemaVersion: Int
    let command: String
}

private final class EventWriter: @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.agentmesh360.speech-helper.output")
    private let encoder = JSONEncoder()

    func send(_ event: HelperEvent) {
        queue.sync {
            guard var data = try? encoder.encode(event) else { return }
            data.append(0x0A)
            FileHandle.standardOutput.write(data)
        }
    }
}

@MainActor
private final class LocalDictationRuntime {
    private let writer: EventWriter
    private let audioEngine = AVAudioEngine()
    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var lastText = ""
    private var tapInstalled = false
    private var stopping = false
    private var finished = false

    init(writer: EventWriter) {
        self.writer = writer
    }

    func start() {
        guard prepareOnDeviceRecognizer() else { return }
        requestMicrophonePermission { [weak self] granted in
            guard let self else { return }
            if !granted {
                self.fail("microphone_permission_denied")
                return
            }
            self.requestSpeechPermission()
        }
    }

    private func prepareOnDeviceRecognizer() -> Bool {
        guard let recognizer = SFSpeechRecognizer() else {
            fail("dictation_language_unavailable")
            return false
        }
        let resolvedIdentifier = Locale.canonicalIdentifier(from: recognizer.locale.identifier)
        let supported = SFSpeechRecognizer.supportedLocales().contains { locale in
            Locale.canonicalIdentifier(from: locale.identifier) == resolvedIdentifier
        }
        guard
            supported,
            recognizer.supportsOnDeviceRecognition
        else {
            fail(supported ? "dictation_on_device_unavailable" : "dictation_language_unavailable")
            return false
        }
        speechRecognizer = recognizer
        return true
    }

    func handle(_ command: HelperCommand) {
        guard command.schemaVersion == protocolVersion else {
            fail("invalid_dictation_request")
            return
        }
        switch command.command {
        case "stop":
            stop()
        case "cancel":
            cancel()
        default:
            fail("invalid_dictation_request")
        }
    }

    func inputClosed() {
        cancel()
    }

    private func requestMicrophonePermission(completion: @escaping @MainActor (Bool) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            completion(true)
        case .notDetermined:
            writer.send(HelperEvent(type: "permission_pending", permission: "microphone"))
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                Task { @MainActor in completion(granted) }
            }
        case .denied, .restricted:
            completion(false)
        @unknown default:
            completion(false)
        }
    }

    private func requestSpeechPermission() {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            beginRecognition()
        case .notDetermined:
            writer.send(HelperEvent(type: "permission_pending", permission: "speech_recognition"))
            SFSpeechRecognizer.requestAuthorization { [weak self] status in
                Task { @MainActor in
                    guard let self else { return }
                    switch status {
                    case .authorized:
                        self.beginRecognition()
                    case .denied:
                        self.fail("speech_recognition_permission_denied")
                    case .restricted:
                        self.fail("speech_recognition_restricted")
                    case .notDetermined:
                        self.fail("speech_recognition_permission_denied")
                    @unknown default:
                        self.fail("speech_recognition_permission_denied")
                    }
                }
            }
        case .denied:
            fail("speech_recognition_permission_denied")
        case .restricted:
            fail("speech_recognition_restricted")
        @unknown default:
            fail("speech_recognition_permission_denied")
        }
    }

    private func beginRecognition() {
        guard !finished else { return }
        guard let recognizer = speechRecognizer else {
            fail("dictation_on_device_unavailable")
            return
        }
        guard recognizer.isAvailable else {
            fail("dictation_on_device_unavailable")
            return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true
        request.taskHint = .dictation
        if #available(macOS 13.0, *) {
            request.addsPunctuation = true
        }
        recognitionRequest = request

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            fail("microphone_unavailable")
            return
        }

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self, !self.finished else { return }
                if let result {
                    let text = boundedTranscript(result.bestTranscription.formattedString)
                    if !text.isEmpty, text != self.lastText {
                        self.lastText = text
                        self.writer.send(HelperEvent(type: "partial", text: text))
                    }
                    if result.isFinal {
                        self.complete(text)
                        return
                    }
                }
                if error != nil {
                    if self.stopping, !self.lastText.isEmpty {
                        self.complete(self.lastText)
                    } else {
                        self.fail(self.lastText.isEmpty ? "dictation_no_speech" : "dictation_failed")
                    }
                }
            }
        }

        inputNode.installTap(onBus: 0, bufferSize: 1_024, format: format) { [weak self] buffer, _ in
            self?.recognitionRequest?.append(buffer)
        }
        tapInstalled = true
        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            fail("microphone_unavailable")
            return
        }

        writer.send(HelperEvent(
            type: "ready",
            engine: "macos_on_device_speech",
            locale: recognizer.locale.identifier,
            onDevice: true
        ))
    }

    private func stop() {
        guard !finished, !stopping else { return }
        stopping = true
        stopAudioCapture()
        recognitionRequest?.endAudio()
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let self, !self.finished else { return }
            if self.lastText.isEmpty {
                self.fail("dictation_no_speech")
            } else {
                self.complete(self.lastText)
            }
        }
    }

    private func cancel() {
        guard !finished else { return }
        finished = true
        stopAudioCapture()
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        speechRecognizer = nil
        writer.send(HelperEvent(type: "cancelled"))
        exitSoon(0)
    }

    private func complete(_ text: String) {
        guard !finished else { return }
        let normalized = boundedTranscript(text).trimmingCharacters(in: .whitespacesAndNewlines)
        if normalized.isEmpty {
            fail("dictation_no_speech")
            return
        }
        finished = true
        stopAudioCapture()
        recognitionRequest?.endAudio()
        recognitionTask?.finish()
        recognitionTask = nil
        recognitionRequest = nil
        speechRecognizer = nil
        writer.send(HelperEvent(type: "final", text: normalized))
        exitSoon(0)
    }

    private func fail(_ code: String) {
        guard !finished else { return }
        finished = true
        stopAudioCapture()
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        speechRecognizer = nil
        writer.send(HelperEvent(type: "error", code: code))
        exitSoon(1)
    }

    private func stopAudioCapture() {
        if tapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        if audioEngine.isRunning {
            audioEngine.stop()
        }
    }

    private func exitSoon(_ status: Int32) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            Darwin.exit(status)
        }
    }
}

private func boundedTranscript(_ text: String) -> String {
    var result = ""
    result.reserveCapacity(min(text.utf8.count, maxTranscriptUTF8Bytes))
    var characterCount = 0
    var byteCount = 0
    for character in text {
        guard characterCount < maxTranscriptCharacters else { break }
        let fragment = String(character)
        if fragment.unicodeScalars.contains(where: { scalar in
            scalar.value == 0 || (scalar.value < 32 && scalar.value != 9 && scalar.value != 10)
        }) {
            continue
        }
        let fragmentBytes = fragment.utf8.count
        guard byteCount + fragmentBytes <= maxTranscriptUTF8Bytes else { break }
        result.append(character)
        characterCount += 1
        byteCount += fragmentBytes
    }
    return result
}

private func writeCapabilitiesAndExit() {
    let recognizer = SFSpeechRecognizer()
    let writer = EventWriter()
    writer.send(HelperEvent(
        type: "capabilities",
        engine: "macos_on_device_speech",
        locale: recognizer?.locale.identifier,
        onDevice: recognizer?.supportsOnDeviceRecognition == true
    ))
}

@main
private struct AgentMesh360SpeechHelper {
    @MainActor
    static func main() {
        if CommandLine.arguments.contains("--capabilities") {
            writeCapabilitiesAndExit()
            return
        }

        let writer = EventWriter()
        let runtime = LocalDictationRuntime(writer: writer)
        DispatchQueue.global(qos: .userInitiated).async {
            while let line = readLine(strippingNewline: true) {
                guard
                    line.utf8.count <= 4_096,
                    let data = line.data(using: .utf8),
                    let command = try? JSONDecoder().decode(HelperCommand.self, from: data)
                else {
                    Task { @MainActor in
                        runtime.handle(HelperCommand(schemaVersion: protocolVersion, command: "invalid"))
                    }
                    return
                }
                Task { @MainActor in runtime.handle(command) }
            }
            Task { @MainActor in runtime.inputClosed() }
        }
        runtime.start()
        RunLoop.main.run()
    }
}
