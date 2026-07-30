fn main() {
    println!("cargo:rerun-if-env-changed=GROK_VERSION");
    println!("cargo:rerun-if-env-changed=AGENTMESH360_HOST_RUNTIME_VERSION");
}
