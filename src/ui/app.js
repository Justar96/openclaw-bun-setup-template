// OpenClaw Setup - Modular UI Application
(function() {
  'use strict';

  // ============================================
  // API Module
  // ============================================
  const API = {
    async request(url, options = {}) {
      options.credentials = 'same-origin';
      const res = await fetch(url, options);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
      }
      return res.json();
    },

    async get(url) {
      return this.request(url);
    },

    async post(url, data) {
      return this.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
    },

    async postRaw(url, body, contentType) {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': contentType },
        body: body
      });
      return res.text();
    }
  };

  // ============================================
  // DOM Helpers
  // ============================================
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function show(el) {
    if (el) el.style.display = 'block';
  }

  function hide(el) {
    if (el) el.style.display = 'none';
  }

  function setHtml(el, html) {
    if (el) el.innerHTML = html;
  }

  function setText(el, text) {
    if (el) el.textContent = text;
  }

  // ============================================
  // Tabs Module
  // ============================================
  const Tabs = {
    init() {
      $$('.tab').forEach(tab => {
        tab.addEventListener('click', () => this.activate(tab.dataset.tab));
        // Keyboard navigation for tabs
        tab.addEventListener('keydown', (e) => this.handleKeydown(e, tab));
      });
    },

    activate(tabId) {
      $$('.tab').forEach(t => {
        const isActive = t.dataset.tab === tabId;
        t.classList.toggle('active', isActive);
        t.setAttribute('aria-selected', isActive);
        t.setAttribute('tabindex', isActive ? '0' : '-1');
      });
      $$('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tabId}`));
    },

    handleKeydown(e, tab) {
      const tabs = Array.from($$('.tab'));
      const currentIndex = tabs.indexOf(tab);
      let newIndex = currentIndex;

      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault();
          newIndex = currentIndex === 0 ? tabs.length - 1 : currentIndex - 1;
          break;
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault();
          newIndex = currentIndex === tabs.length - 1 ? 0 : currentIndex + 1;
          break;
        case 'Home':
          e.preventDefault();
          newIndex = 0;
          break;
        case 'End':
          e.preventDefault();
          newIndex = tabs.length - 1;
          break;
        default:
          return;
      }

      tabs[newIndex].focus();
      this.activate(tabs[newIndex].dataset.tab);
    }
  };

  // ============================================
  // Collapsible Module
  // ============================================
  const Collapsible = {
    init() {
      $$('.collapsible-toggle').forEach(toggle => {
        toggle.addEventListener('click', () => {
          const collapsible = toggle.parentElement;
          const isOpen = collapsible.classList.toggle('open');
          toggle.setAttribute('aria-expanded', isOpen);
        });
        // Keyboard support - Enter and Space
        toggle.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle.click();
          }
        });
      });
      // Set initial aria-expanded states
      $$('.collapsible').forEach(collapsible => {
        const toggle = collapsible.querySelector('.collapsible-toggle');
        if (toggle) {
          toggle.setAttribute('aria-expanded', collapsible.classList.contains('open'));
        }
      });
    }
  };

  // ============================================
  // Status Module
  // ============================================
  const Status = {
    el: null,
    authGroups: [],

    init() {
      this.el = $('#statusBadge');
      this.refresh();
    },

    async refresh() {
      try {
        const data = await API.get('/setup/api/status');
        this.authGroups = data.authGroups || [];
        this.render(data);
        Auth.renderGroups(this.authGroups);
        Config.load();
      } catch (e) {
        setHtml(this.el, `<span class="text-danger">Error: ${e.message}</span>`);
      }
    },

    render(data) {
      const configured = data.configured;
      const version = data.openclawVersion || '';
      const error = data.error || data.lastError || '';
      const card = this.el?.closest('.status-card');
      
      if (error) {
        this.el.className = 'status-badge error';
        setHtml(this.el, `<span class="status-text">Error</span>`);
        // Add error log below the badge
        const parent = this.el.parentElement;
        let logEl = parent.querySelector('.status-log');
        if (!logEl) {
          logEl = document.createElement('div');
          logEl.className = 'status-log';
          parent.appendChild(logEl);
        }
        setText(logEl, error);
        card?.classList.add('has-log');
      } else if (configured) {
        this.el.className = 'status-badge success';
        setHtml(this.el, `<span class="status-text">Configured</span>${version ? ` <span class="status-version">${version}</span>` : ''}`);
        this.removeErrorLog();
        card?.classList.remove('has-log');
      } else {
        this.el.className = 'status-badge warning';
        setHtml(this.el, `<span class="status-text">Not configured</span>`);
        this.removeErrorLog();
        card?.classList.remove('has-log');
      }
    },
    
    removeErrorLog() {
      const parent = this.el?.parentElement;
      const logEl = parent?.querySelector('.status-log');
      if (logEl) logEl.remove();
    }
  };

  // ============================================
  // Auth Module
  // ============================================
  const Auth = {
    groupEl: null,
    choiceEl: null,
    groups: [],

    init() {
      this.groupEl = $('#authGroup');
      this.choiceEl = $('#authChoice');
      
      if (this.groupEl) {
        this.groupEl.addEventListener('change', () => this.renderChoices());
      }
    },

    renderGroups(groups) {
      this.groups = groups;
      if (!this.groupEl) return;

      this.groupEl.innerHTML = groups.map(g => 
        `<option value="${g.value}">${g.label}${g.hint ? ` - ${g.hint}` : ''}</option>`
      ).join('');

      this.renderChoices();
    },

    renderChoices() {
      if (!this.choiceEl || !this.groupEl) return;

      const selected = this.groups.find(g => g.value === this.groupEl.value);
      const options = selected?.options || [];

      this.choiceEl.innerHTML = options.map(o =>
        `<option value="${o.value}">${o.label}${o.hint ? ` - ${o.hint}` : ''}</option>`
      ).join('');
    }
  };

  // ============================================
  // Setup Module
  // ============================================
  const Setup = {
    logEl: null,

    init() {
      this.logEl = $('#setupLog');

      $('#runSetup')?.addEventListener('click', () => this.run());
      $('#resetSetup')?.addEventListener('click', () => this.reset());
    },

    async run() {
      const payload = {
        flow: $('#flow')?.value,
        authChoice: $('#authChoice')?.value,
        authSecret: $('#authSecret')?.value,
        telegramToken: $('#telegramToken')?.value,
        discordToken: $('#discordToken')?.value,
        discordDmPolicy: $('#discordDmPolicy')?.value || 'pairing',
        discordAllowFrom: $('#discordAllowFrom')?.value || '',
        discordGuildId: $('#discordGuildId')?.value || '',
        discordChannelId: $('#discordChannelId')?.value || '',
        discordRequireMention: $('#discordRequireMention')?.checked ? 'true' : 'false',
        discordNativeCommands: $('#discordNativeCommands')?.checked ? 'true' : 'false',
        discordHistoryLimit: $('#discordHistoryLimit')?.value || '20',
        discordStreamMode: $('#discordStreamMode')?.value || 'partial',
        slackBotToken: $('#slackBotToken')?.value,
        slackAppToken: $('#slackAppToken')?.value
      };

      show(this.logEl);
      setText(this.logEl, 'Running setup...\n');

      try {
        const result = await API.post('/setup/api/run', payload);
        setText(this.logEl, result.output || JSON.stringify(result, null, 2));
        Status.refresh();
      } catch (e) {
        setText(this.logEl, `Error: ${e.message}`);
      }
    },

    async reset() {
      if (!confirm('Reset setup? This deletes the config file.')) return;

      show(this.logEl);
      setText(this.logEl, 'Resetting...\n');

      try {
        const text = await API.postRaw('/setup/api/reset', '', 'text/plain');
        setText(this.logEl, text);
        Status.refresh();
      } catch (e) {
        setText(this.logEl, `Error: ${e.message}`);
      }
    }
  };

  // ============================================
  // Pairing Module
  // ============================================
  const Pairing = {
    listEl: null,
    outEl: null,
    autoInterval: null,

    init() {
      this.listEl = $('#pairingList');
      this.outEl = $('#pairingOut');

      $('#pairingRefresh')?.addEventListener('click', () => this.refresh());
      $('#pairingApprove')?.addEventListener('click', () => this.approveManual());
      
      $('#pairingAutoRefresh')?.addEventListener('change', (e) => {
        this.setAutoRefresh(e.target.checked);
      });
    },

    async refresh() {
      if (!this.listEl) return;

      setHtml(this.listEl, '<div class="pairing-empty loading">Loading...</div>');

      try {
        const data = await API.get('/setup/api/pairing/list');
        this.render(data.channels || {});
      } catch (e) {
        setHtml(this.listEl, `<div class="pairing-empty text-danger">Error: ${e.message}</div>`);
      }
    },

    render(channels) {
      let html = '';
      let total = 0;

      for (const [ch, info] of Object.entries(channels)) {
        const pending = info.pending || [];
        if (pending.length > 0) {
          total += pending.length;
          pending.forEach(p => {
            html += `
              <div class="pairing-item">
                <span class="pairing-channel">${ch}</span>
                <span class="pairing-code">${p.code || 'N/A'}</span>
                ${p.user && p.user !== 'unknown' ? `<span class="pairing-user">from ${p.user}</span>` : ''}
                <button class="btn btn-success btn-sm pairing-quick-approve" 
                        data-channel="${ch}" data-code="${p.code || ''}">
                  Approve
                </button>
              </div>
            `;
          });
        }
      }

      if (total === 0) {
        html = '<div class="pairing-empty">No pending requests. When users DM your bot, their codes appear here.</div>';
      }

      setHtml(this.listEl, html);

      // Attach quick approve handlers
      this.listEl.querySelectorAll('.pairing-quick-approve').forEach(btn => {
        btn.addEventListener('click', () => {
          this.approve(btn.dataset.channel, btn.dataset.code);
        });
      });
    },

    async approve(channel, code) {
      show(this.outEl);
      setText(this.outEl, `Approving ${channel} / ${code}...`);

      try {
        const result = await API.post('/setup/api/pairing/approve', { channel, code });
        const msg = result.ok ? 'Approved successfully' : `Failed: ${result.output || result.error}`;
        setText(this.outEl, msg + '\n' + (result.output || ''));
        this.refresh();
      } catch (e) {
        setText(this.outEl, `Error: ${e.message}`);
      }
    },

    approveManual() {
      const channel = $('#pairingChannel')?.value;
      const code = ($('#pairingCode')?.value || '').trim().toUpperCase();
      
      if (!code) {
        alert('Enter a pairing code');
        return;
      }

      this.approve(channel, code);
      $('#pairingCode').value = '';
    },

    setAutoRefresh(enabled) {
      if (this.autoInterval) {
        clearInterval(this.autoInterval);
        this.autoInterval = null;
      }

      if (enabled) {
        this.refresh();
        this.autoInterval = setInterval(() => this.refresh(), 10000);
      }
    }
  };

  // ============================================
  // Config Module
  // ============================================
  const Config = {
    textEl: null,
    pathEl: null,
    outEl: null,

    init() {
      this.textEl = $('#configText');
      this.pathEl = $('#configPath');
      this.outEl = $('#configOut');

      $('#configReload')?.addEventListener('click', () => this.load());
      $('#configSave')?.addEventListener('click', () => this.save());
    },

    async load() {
      if (!this.textEl) return;

      try {
        const data = await API.get('/setup/api/config/raw');
        setText(this.pathEl, `Config: ${data.path || 'unknown'}${data.exists ? '' : ' (not created yet)'}`);
        this.textEl.value = data.content || '';
      } catch (e) {
        setText(this.pathEl, `Error: ${e.message}`);
      }
    },

    async save() {
      if (!confirm('Save config and restart gateway?')) return;

      show(this.outEl);
      setText(this.outEl, 'Saving...');

      try {
        const result = await API.post('/setup/api/config/raw', { content: this.textEl.value });
        setText(this.outEl, result.ok ? `Saved: ${result.path}\nGateway restarted.` : `Error: ${result.error}`);
        Status.refresh();
      } catch (e) {
        setText(this.outEl, `Error: ${e.message}`);
      }
    }
  };

  // ============================================
  // Console Module
  // ============================================
  const Console = {
    outEl: null,

    init() {
      this.outEl = $('#consoleOut');
      $('#consoleRun')?.addEventListener('click', () => this.run());
    },

    async run() {
      const cmd = $('#consoleCmd')?.value;
      const arg = $('#consoleArg')?.value || '';

      setText(this.outEl, `Running ${cmd}...`);

      try {
        const result = await API.post('/setup/api/console/run', { cmd, arg });
        setText(this.outEl, result.output || JSON.stringify(result, null, 2));
        Status.refresh();
      } catch (e) {
        setText(this.outEl, `Error: ${e.message}`);
      }
    }
  };

  // ============================================
  // Backup Module
  // ============================================
  const Backup = {
    outEl: null,

    init() {
      this.outEl = $('#importOut');
      $('#importRun')?.addEventListener('click', () => this.import());
    },

    async import() {
      const fileInput = $('#importFile');
      const file = fileInput?.files?.[0];

      if (!file) {
        alert('Select a .tar.gz file first');
        return;
      }

      if (!confirm('Import backup? This overwrites files under /data.')) return;

      show(this.outEl);
      setText(this.outEl, `Uploading ${file.name} (${file.size} bytes)...`);

      try {
        const buf = await file.arrayBuffer();
        const text = await API.postRaw('/setup/import', buf, 'application/gzip');
        setText(this.outEl, text);
        Status.refresh();
      } catch (e) {
        setText(this.outEl, `Error: ${e.message}`);
      }
    }
  };

  // ============================================
  // Initialize App
  // ============================================
  document.addEventListener('DOMContentLoaded', () => {
    Tabs.init();
    Collapsible.init();
    Auth.init();
    Status.init();
    Setup.init();
    Pairing.init();
    Config.init();
    Console.init();
    Backup.init();
  });
})();
