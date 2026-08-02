'use strict';

(() => {
  const instances = new Set();
  let openInstance = null;
  let nextId = 0;

  class AppSelect {
    constructor(select) {
      this.select = select;
      this.originalTabIndex = select.getAttribute('tabindex');
      this.originalAriaHidden = select.getAttribute('aria-hidden');
      this.activeValue = null;
      this.typeahead = '';
      this.typeaheadTimer = null;
      this.id = `app-select-${++nextId}`;

      this.wrapper = document.createElement('div');
      this.wrapper.className = 'app-select';
      select.parentNode.insertBefore(this.wrapper, select);
      this.wrapper.append(select);

      select.classList.add('app-select-native');
      select.setAttribute('tabindex', '-1');
      select.setAttribute('aria-hidden', 'true');

      this.trigger = document.createElement('button');
      this.trigger.type = 'button';
      this.trigger.className = 'app-select-trigger';
      this.trigger.setAttribute('role', 'combobox');
      this.trigger.setAttribute('aria-haspopup', 'listbox');
      this.trigger.setAttribute('aria-expanded', 'false');
      this.trigger.setAttribute('aria-controls', `${this.id}-menu`);
      this.trigger.dataset.selectName = select.name || select.id || this.id;
      this.trigger.setAttribute('aria-label', selectLabel(select));
      this.trigger.innerHTML = [
        '<span class="app-select-value"></span>',
        '<svg class="app-select-chevron" viewBox="0 0 20 20" aria-hidden="true">',
        '<path d="m5.5 7.5 4.5 4.5 4.5-4.5"/></svg>',
      ].join('');
      this.wrapper.append(this.trigger);

      this.menu = document.createElement('div');
      this.menu.id = `${this.id}-menu`;
      this.menu.className = 'app-select-menu';
      this.menu.setAttribute('role', 'listbox');
      this.menu.dataset.open = 'false';
      this.menu.hidden = true;
      document.body.append(this.menu);

      this.onTriggerClick = () => (this.isOpen() ? this.close() : this.open());
      this.onTriggerKeydown = (event) => this.handleKeydown(event);
      this.onSelectChange = () => queueMicrotask(() => syncAll());
      this.onSelectInvalid = (event) => {
        event.preventDefault();
        this.trigger.focus();
        this.trigger.setAttribute('aria-invalid', 'true');
      };
      this.onDocumentPointerDown = (event) => {
        if (!this.isOpen()) return;
        if (this.wrapper.contains(event.target) || this.menu.contains(event.target)) return;
        this.close({ restoreFocus: false });
      };
      this.onViewportChange = () => {
        if (this.isOpen()) this.positionMenu();
      };

      this.trigger.addEventListener('click', this.onTriggerClick);
      this.trigger.addEventListener('keydown', this.onTriggerKeydown);
      select.addEventListener('change', this.onSelectChange);
      select.addEventListener('invalid', this.onSelectInvalid);
      document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
      window.addEventListener('resize', this.onViewportChange);
      window.addEventListener('scroll', this.onViewportChange, true);

      this.observer = new MutationObserver(() => queueMicrotask(() => this.sync()));
      this.observer.observe(select, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['disabled', 'label', 'selected', 'value'],
      });
      this.sync();
    }

    isOpen() {
      return this.menu.dataset.open === 'true';
    }

    sync() {
      if (!this.select.isConnected || !this.trigger.isConnected) return;
      const selected = this.select.selectedOptions[0] || this.select.options[0];
      const label = selected?.textContent?.trim() || '请选择';
      this.trigger.querySelector('.app-select-value').textContent = label;
      this.trigger.disabled = this.select.disabled;
      this.wrapper.classList.toggle('is-disabled', this.select.disabled);
      this.trigger.classList.toggle('is-placeholder', !this.select.value);
      if (this.select.value) this.trigger.removeAttribute('aria-invalid');
      this.buildMenu();
      if (this.isOpen()) this.positionMenu();
    }

    buildMenu() {
      const currentActive = this.activeValue;
      this.menu.replaceChildren();
      for (const child of this.select.children) {
        if (child.tagName === 'OPTGROUP') {
          const group = document.createElement('div');
          group.className = 'app-select-group';
          group.setAttribute('role', 'presentation');
          const heading = document.createElement('div');
          heading.className = 'app-select-group-label';
          heading.textContent = child.label;
          group.append(heading);
          for (const option of child.children) group.append(this.optionNode(option));
          this.menu.append(group);
        } else if (child.tagName === 'OPTION') {
          this.menu.append(this.optionNode(child));
        }
      }
      const active = this.findOption(currentActive)
        || this.findOption(this.select.value)
        || this.enabledOptions()[0];
      this.setActive(active?.dataset.value ?? null, { scroll: false });
    }

    optionNode(option) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'app-select-option';
      item.setAttribute('role', 'option');
      item.tabIndex = -1;
      item.setAttribute('aria-selected', option.selected ? 'true' : 'false');
      item.dataset.value = option.value;
      item.disabled = option.disabled || option.parentElement?.disabled === true;
      item.textContent = option.textContent?.trim() || option.value;
      item.addEventListener('pointermove', () => {
        if (!item.disabled) this.setActive(item.dataset.value, { scroll: false });
      });
      item.addEventListener('click', () => this.choose(item.dataset.value));
      return item;
    }

    enabledOptions() {
      return [...this.menu.querySelectorAll('[role="option"]:not([disabled])')];
    }

    findOption(value) {
      if (value === null || value === undefined) return null;
      return this.enabledOptions().find((item) => item.dataset.value === String(value)) || null;
    }

    setActive(value, { scroll = true } = {}) {
      this.activeValue = value;
      for (const item of this.menu.querySelectorAll('[role="option"]')) {
        item.removeAttribute('id');
        item.classList.toggle('is-active', value !== null && item.dataset.value === String(value));
      }
      const active = this.findOption(value);
      if (active) {
        this.trigger.setAttribute('aria-activedescendant', `${this.id}-active`);
        active.id = `${this.id}-active`;
        if (scroll) active.scrollIntoView({ block: 'nearest' });
      } else {
        this.trigger.removeAttribute('aria-activedescendant');
      }
    }

    open({ direction = 1 } = {}) {
      if (this.select.disabled || this.isOpen()) return;
      if (openInstance && openInstance !== this) openInstance.close({ restoreFocus: false });
      openInstance = this;
      this.buildMenu();
      const options = this.enabledOptions();
      if (!this.findOption(this.activeValue)) {
        const selected = this.findOption(this.select.value);
        const fallback = direction < 0 ? options.at(-1) : options[0];
        this.setActive((selected || fallback)?.dataset.value ?? null, { scroll: false });
      }
      this.menu.hidden = false;
      this.menu.dataset.open = 'true';
      this.trigger.setAttribute('aria-expanded', 'true');
      this.wrapper.classList.add('is-open');
      this.positionMenu();
      requestAnimationFrame(() => this.findOption(this.activeValue)?.scrollIntoView({ block: 'nearest' }));
    }

    close({ restoreFocus = false } = {}) {
      if (!this.isOpen()) return;
      this.menu.dataset.open = 'false';
      this.menu.hidden = true;
      this.trigger.setAttribute('aria-expanded', 'false');
      this.trigger.removeAttribute('aria-activedescendant');
      this.wrapper.classList.remove('is-open');
      if (openInstance === this) openInstance = null;
      if (restoreFocus && this.trigger.isConnected) this.trigger.focus();
    }

    positionMenu() {
      if (!this.isOpen() || !this.trigger.isConnected) return;
      const rect = this.trigger.getBoundingClientRect();
      const edge = 12;
      const gap = 6;
      const width = Math.min(Math.max(rect.width, 220), window.innerWidth - edge * 2);
      const maxHeight = Math.min(320, window.innerHeight - edge * 2);
      this.menu.style.width = `${width}px`;
      this.menu.style.maxHeight = `${maxHeight}px`;
      this.menu.style.left = `${Math.min(
        Math.max(edge, rect.left),
        window.innerWidth - width - edge,
      )}px`;
      const measuredHeight = Math.min(this.menu.scrollHeight, maxHeight);
      const roomBelow = window.innerHeight - rect.bottom - edge;
      const roomAbove = rect.top - edge;
      const openAbove = roomBelow < Math.min(measuredHeight, 180) && roomAbove > roomBelow;
      const top = openAbove
        ? Math.max(edge, rect.top - measuredHeight - gap)
        : Math.min(window.innerHeight - measuredHeight - edge, rect.bottom + gap);
      this.menu.style.top = `${Math.max(edge, top)}px`;
      this.menu.classList.toggle('opens-above', openAbove);
    }

    choose(value) {
      const item = this.findOption(value);
      if (!item || item.disabled) return;
      this.select.value = value;
      this.close({ restoreFocus: true });
      this.select.dispatchEvent(new Event('change', { bubbles: true }));
      queueMicrotask(() => syncAll());
    }

    moveActive(delta) {
      const options = this.enabledOptions();
      if (!options.length) return;
      const current = options.findIndex((item) => item.dataset.value === String(this.activeValue));
      const nextIndex = current < 0
        ? (delta < 0 ? options.length - 1 : 0)
        : Math.min(Math.max(current + delta, 0), options.length - 1);
      this.setActive(options[nextIndex].dataset.value);
    }

    handleKeydown(event) {
      if (event.key === 'Escape' && this.isOpen()) {
        event.preventDefault();
        event.stopPropagation();
        this.close();
        return;
      }
      if (event.key === 'Tab') {
        this.close({ restoreFocus: false });
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        if (!this.isOpen()) this.open({ direction: event.key === 'ArrowUp' ? -1 : 1 });
        else this.moveActive(event.key === 'ArrowUp' ? -1 : 1);
        return;
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        event.stopPropagation();
        if (!this.isOpen()) this.open();
        const options = this.enabledOptions();
        const item = event.key === 'Home' ? options[0] : options.at(-1);
        this.setActive(item?.dataset.value ?? null);
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        if (!this.isOpen()) this.open();
        else this.choose(this.activeValue);
        return;
      }
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        this.typeahead += event.key.toLocaleLowerCase();
        clearTimeout(this.typeaheadTimer);
        this.typeaheadTimer = setTimeout(() => { this.typeahead = ''; }, 650);
        if (!this.isOpen()) this.open();
        const match = this.enabledOptions().find(
          (item) => item.textContent.trim().toLocaleLowerCase().startsWith(this.typeahead),
        );
        if (match) this.setActive(match.dataset.value);
      }
    }

    destroy() {
      clearTimeout(this.typeaheadTimer);
      this.observer.disconnect();
      this.close({ restoreFocus: false });
      this.trigger.removeEventListener('click', this.onTriggerClick);
      this.trigger.removeEventListener('keydown', this.onTriggerKeydown);
      this.select.removeEventListener('change', this.onSelectChange);
      this.select.removeEventListener('invalid', this.onSelectInvalid);
      document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
      window.removeEventListener('resize', this.onViewportChange);
      window.removeEventListener('scroll', this.onViewportChange, true);
      if (this.wrapper.isConnected) {
        this.wrapper.parentNode.insertBefore(this.select, this.wrapper);
        this.wrapper.remove();
      }
      this.menu.remove();
      this.select.classList.remove('app-select-native');
      restoreAttribute(this.select, 'tabindex', this.originalTabIndex);
      restoreAttribute(this.select, 'aria-hidden', this.originalAriaHidden);
      instances.delete(this);
    }
  }

  function selectLabel(select) {
    if (select.getAttribute('aria-label')) return select.getAttribute('aria-label');
    const fieldLabel = select.closest('label')?.querySelector(':scope > span')?.textContent?.trim();
    return fieldLabel || select.name || '选择选项';
  }

  function restoreAttribute(element, name, value) {
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  }

  function enhance(root = document) {
    for (const select of root.querySelectorAll('select')) {
      if (select.classList.contains('app-select-native')) continue;
      const instance = new AppSelect(select);
      instances.add(instance);
    }
  }

  function syncAll() {
    for (const instance of instances) instance.sync();
  }

  function destroyAll() {
    for (const instance of [...instances]) instance.destroy();
    openInstance = null;
  }

  window.AgentMeshSelect = Object.freeze({ enhance, syncAll, destroyAll });
})();
