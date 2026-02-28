// Setup UI behavior for the OpenClaw wrapper.
(function() {
  'use strict';

  // API helpers for setup endpoints.
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

  // Lightweight DOM helpers.
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

  // Toast Notification System
  const Toast = {
    container: null,
    queue: [],
    
    init() {
      this.container = $('#toastContainer');
      if (!this.container) {
        this.container = document.createElement('div');
        this.container.id = 'toastContainer';
        this.container.className = 'toast-container';
        this.container.setAttribute('aria-live', 'polite');
        this.container.setAttribute('aria-atomic', 'true');
        document.body.appendChild(this.container);
      }
    },
    
    show(message, options = {}) {
      const {
        type = 'info', // info, success, error, warning
        title = '',
        duration = 4000,
        closable = true
      } = options;
      
      const icons = {
        success: '✓',
        error: '✗',
        warning: '!',
        info: 'i'
      };
      
      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;
      toast.innerHTML = `
        <span class="toast-icon" aria-hidden="true">${icons[type] || icons.info}</span>
        <div class="toast-content">
          ${title ? `<div class="toast-title">${this.escapeHtml(title)}</div>` : ''}
          <div class="toast-message">${this.escapeHtml(message)}</div>
        </div>
        ${closable ? '<button class="toast-close" aria-label="Close notification">×</button>' : ''}
      `;
      
      if (closable) {
        toast.querySelector('.toast-close').addEventListener('click', () => this.dismiss(toast));
      }
      
      this.container.appendChild(toast);
      
      if (duration > 0) {
        setTimeout(() => this.dismiss(toast), duration);
      }
      
      return toast;
    },
    
    dismiss(toast) {
      if (!toast || !toast.parentNode) return;
      toast.classList.add('toast-exit');
      setTimeout(() => toast.remove(), 200);
    },
    
    success(message, title = '') {
      return this.show(message, { type: 'success', title });
    },
    
    error(message, title = 'Error') {
      return this.show(message, { type: 'error', title, duration: 6000 });
    },
    
    warning(message, title = '') {
      return this.show(message, { type: 'warning', title });
    },
    
    info(message, title = '') {
      return this.show(message, { type: 'info', title });
    },
    
    escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }
  };

  // Tabbed navigation for the main sections.
  const Tabs = {
    init() {
      $$('.tab').forEach(tab => {
        tab.addEventListener('click', () => this.activate(tab.dataset.tab));
        // Support arrow-key navigation.
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
      
      // Auto-refresh pairing when switching to that tab
      if (tabId === 'pairing') {
        Pairing.refresh();
      }
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

  // Collapsible sections with ARIA updates.
  const Collapsible = {
    init() {
      $$('.collapsible-toggle').forEach(toggle => {
        toggle.addEventListener('click', () => {
          const collapsible = toggle.parentElement;
          const isOpen = collapsible.classList.toggle('open');
          toggle.setAttribute('aria-expanded', isOpen);
        });
        // Support Enter and Space toggles.
        toggle.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle.click();
          }
        });
      });
      // Initialize aria-expanded for pre-opened sections.
      $$('.collapsible').forEach(collapsible => {
        const toggle = collapsible.querySelector('.collapsible-toggle');
        if (toggle) {
          toggle.setAttribute('aria-expanded', collapsible.classList.contains('open'));
        }
      });
    }
  };

  // Status badge rendering and refresh logic.
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
        // Render an error log beneath the badge.
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

  // Auth provider selection UI.
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

  // Setup form submission and reset.
  const Setup = {
    logEl: null,
    isRunning: false,
    connectivityEl: null,
    testResultsEl: null,

    init() {
      this.logEl = $('#setupLog');
      this.connectivityEl = $('#connectivityResults');
      this.testResultsEl = $('#testResultsList');

      $('#runSetup')?.addEventListener('click', () => this.run());
      $('#resetSetup')?.addEventListener('click', () => this.reset());
      $('#testConnectivity')?.addEventListener('click', () => this.testConnectivity());
      
      // Add input validation listeners
      this.setupValidation();
      
      // Update progress steps based on section visibility
      this.updateProgressSteps(1);
    },
    
    updateProgressSteps(activeStep) {
      $$('.setup-step').forEach((step, index) => {
        const stepNum = index + 1;
        step.classList.remove('active', 'completed');
        if (stepNum < activeStep) {
          step.classList.add('completed');
        } else if (stepNum === activeStep) {
          step.classList.add('active');
        }
      });
    },
    
    setupValidation() {
      // Validate token formats on blur
      const tokenInputs = ['#telegramToken', '#discordToken', '#slackBotToken', '#slackAppToken'];
      
      tokenInputs.forEach(sel => {
        const input = $(sel);
        if (!input) return;
        
        input.addEventListener('blur', () => this.validateTokenField(input));
        input.addEventListener('input', () => {
          // Clear error on new input
          input.parentElement?.classList.remove('has-error');
          const errorEl = input.parentElement?.querySelector('.field-error');
          if (errorEl) errorEl.remove();
        });
      });
      
      // Track section changes for progress
      $$('.collapsible-toggle').forEach(toggle => {
        toggle.addEventListener('click', () => {
          setTimeout(() => {
            const authOpen = $('#authSection')?.classList.contains('open');
            const channelsOpen = $('#channelsSection')?.classList.contains('open');
            if (channelsOpen) this.updateProgressSteps(2);
            else if (authOpen) this.updateProgressSteps(1);
          }, 100);
        });
      });
    },
    
    validateTokenField(input) {
      const value = input.value.trim();
      if (!value) return true; // Empty is OK (optional fields)
      
      const id = input.id;
      let valid = true;
      let errorMsg = '';
      
      if (id === 'telegramToken') {
        // Telegram tokens are: {bot_id}:{token}, e.g., 123456:ABC-DEF
        if (!/^\d+:[A-Za-z0-9_-]+$/.test(value)) {
          valid = false;
          errorMsg = 'Invalid format. Expected: 123456:ABC... (get from @BotFather)';
        }
      } else if (id === 'discordToken') {
        // Discord tokens are long alphanumeric strings with dots
        if (value.length < 50) {
          valid = false;
          errorMsg = 'Token seems too short. Check the Bot Token from Discord Developer Portal.';
        }
      } else if (id === 'slackBotToken') {
        if (!value.startsWith('xoxb-')) {
          valid = false;
          errorMsg = 'Bot tokens should start with xoxb-';
        }
      } else if (id === 'slackAppToken') {
        if (!value.startsWith('xapp-')) {
          valid = false;
          errorMsg = 'App tokens should start with xapp-';
        }
      }
      
      const parent = input.parentElement;
      if (!valid && parent) {
        parent.classList.add('has-error');
        let errorEl = parent.querySelector('.field-error');
        if (!errorEl) {
          errorEl = document.createElement('span');
          errorEl.className = 'field-error';
          parent.appendChild(errorEl);
        }
        errorEl.textContent = errorMsg;
      } else if (parent) {
        parent.classList.remove('has-error');
        parent.classList.add('has-success');
        const errorEl = parent.querySelector('.field-error');
        if (errorEl) errorEl.remove();
      }
      
      return valid;
    },
    
    validateAll() {
      const issues = [];
      
      // Check if at least auth is configured
      const authSecret = $('#authSecret')?.value?.trim();
      const authChoice = $('#authChoice')?.value;
      
      if (!authSecret && authChoice && !authChoice.includes('local')) {
        issues.push('Please provide an API key or token for the selected provider.');
      }
      
      // Validate any channel tokens that are provided
      const tokenInputs = ['#telegramToken', '#discordToken', '#slackBotToken', '#slackAppToken'];
      tokenInputs.forEach(sel => {
        const input = $(sel);
        if (input?.value?.trim() && !this.validateTokenField(input)) {
          issues.push(`Invalid ${input.id.replace(/Token$/, '')} token format.`);
        }
      });
      
      return issues;
    },
    
    async testConnectivity() {
      show(this.connectivityEl);
      
      const tests = [
        { name: 'API Status', endpoint: '/setup/api/status' },
        { name: 'Gateway Health', endpoint: '/setup/api/console/run', body: { cmd: 'openclaw.health' } }
      ];
      
      let html = '';
      tests.forEach(t => {
        html += `<div class="test-item pending" data-test="${t.name}">
          <span class="test-icon">○</span>
          <span class="test-label">${t.name}</span>
          <span class="test-detail">Testing...</span>
        </div>`;
      });
      setHtml(this.testResultsEl, html);
      
      for (const test of tests) {
        const itemEl = this.testResultsEl.querySelector(`[data-test="${test.name}"]`);
        try {
          const start = Date.now();
          let result;
          if (test.body) {
            result = await API.post(test.endpoint, test.body);
          } else {
            result = await API.get(test.endpoint);
          }
          const elapsed = Date.now() - start;
          
          if (itemEl) {
            itemEl.classList.remove('pending');
            itemEl.classList.add('success');
            itemEl.querySelector('.test-icon').textContent = '✓';
            itemEl.querySelector('.test-detail').textContent = `OK (${elapsed}ms)`;
          }
        } catch (e) {
          if (itemEl) {
            itemEl.classList.remove('pending');
            itemEl.classList.add('error');
            itemEl.querySelector('.test-icon').textContent = '✗';
            itemEl.querySelector('.test-detail').textContent = e.message;
          }
        }
      }
      
      Toast.success('Connection tests completed');
    },

    async run() {
      if (this.isRunning) return;
      
      // Validate inputs first
      const issues = this.validateAll();
      if (issues.length > 0) {
        Toast.warning(issues.join(' '));
        return;
      }
      
      this.isRunning = true;
      const runBtn = $('#runSetup');
      if (runBtn) {
        runBtn.disabled = true;
        runBtn.textContent = 'Running Setup...';
      }
      
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
        
        if (result.ok) {
          Toast.success('Setup completed successfully! You can now configure channels and approve users.', 'Setup Complete');
          this.updateProgressSteps(4); // Move to "Approve Users" step
          // Highlight the Pairing tab
          const pairingTab = $('#tab-btn-pairing');
          if (pairingTab) {
            pairingTab.style.animation = 'badge-pulse 1s ease-in-out 3';
          }
        } else {
          Toast.error('Setup encountered issues. Check the log output for details.');
        }
        
        Status.refresh();
      } catch (e) {
        setText(this.logEl, `Error: ${e.message}`);
        Toast.error(e.message, 'Setup Failed');
      } finally {
        this.isRunning = false;
        if (runBtn) {
          runBtn.disabled = false;
          runBtn.textContent = 'Run Setup';
        }
      }
    },

    async reset() {
      if (!confirm('Reset setup? This deletes the config file and you will need to reconfigure everything.')) return;

      show(this.logEl);
      setText(this.logEl, 'Resetting...\n');

      try {
        const text = await API.postRaw('/setup/api/reset', '', 'text/plain');
        setText(this.logEl, text);
        Toast.info('Setup has been reset. You can now reconfigure from scratch.');
        Status.refresh();
      } catch (e) {
        setText(this.logEl, `Error: ${e.message}`);
        Toast.error(e.message, 'Reset Failed');
      }
    }
  };

  // Pairing list refresh and approval flow.
  const Pairing = {
    listEl: null,
    outEl: null,
    statusEl: null,
    badgeEl: null,
    autoInterval: null,
    pendingCount: 0,
    isRefreshing: false,

    init() {
      this.listEl = $('#pairingList');
      this.outEl = $('#pairingOut');
      this.statusEl = $('#pairingStatus');
      this.badgeEl = $('#pairingBadge');

      $('#pairingRefresh')?.addEventListener('click', () => this.refresh());
      $('#pairingApprove')?.addEventListener('click', () => this.approveManual());
      
      $('#pairingAutoRefresh')?.addEventListener('change', (e) => {
        this.setAutoRefresh(e.target.checked);
      });
      
      // Auto-format pairing code input (uppercase)
      $('#pairingCode')?.addEventListener('input', (e) => {
        e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      });
      
      // Submit on Enter in code field
      $('#pairingCode')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.approveManual();
        }
      });
    },
    
    setStatus(state, message) {
      if (!this.statusEl) return;
      this.statusEl.className = `pairing-status ${state}`;
      const label = this.statusEl.querySelector('.status-label');
      if (label) label.textContent = message;
    },
    
    updateBadge(count) {
      this.pendingCount = count;
      if (!this.badgeEl) return;
      
      if (count > 0) {
        this.badgeEl.textContent = count > 99 ? '99+' : count;
        this.badgeEl.style.display = 'inline-flex';
        // Show notification if count increased
        if (count > this.lastCount && this.lastCount !== undefined) {
          Toast.info(`${count - this.lastCount} new pairing request(s)`, 'New Request');
        }
      } else {
        this.badgeEl.style.display = 'none';
      }
      this.lastCount = count;
    },

    async refresh() {
      if (!this.listEl || this.isRefreshing) return;
      
      this.isRefreshing = true;
      this.setStatus('refreshing', 'Checking...');

      try {
        const data = await API.get('/setup/api/pairing/list');
        this.render(data.channels || {});
        this.setStatus('success', 'Updated');
        setTimeout(() => this.setStatus('', 'Ready'), 2000);
      } catch (e) {
        setHtml(this.listEl, `<div class="pairing-empty"><div class="empty-icon">⚠</div><div class="empty-title">Error loading requests</div><div class="empty-hint">${e.message}</div></div>`);
        this.setStatus('error', 'Error');
        Toast.error(e.message, 'Failed to load pairing requests');
      } finally {
        this.isRefreshing = false;
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
            const user = p.user && p.user !== 'unknown' ? p.user : '';
            const timeAgo = p.timestamp ? this.formatTimeAgo(p.timestamp) : '';
            
            html += `
              <div class="pairing-item" data-channel="${ch}" data-code="${p.code || ''}">
                <span class="pairing-channel">${this.escapeHtml(ch)}</span>
                <div class="pairing-info">
                  ${user ? `<span class="pairing-user">${this.escapeHtml(user)}</span>` : '<span class="pairing-user">Unknown user</span>'}
                  ${timeAgo ? `<span class="pairing-time">${timeAgo}</span>` : ''}
                </div>
                <div class="pairing-code-wrapper">
                  <span class="pairing-code">${this.escapeHtml(p.code || 'N/A')}</span>
                  <button class="copy-btn" data-code="${this.escapeHtml(p.code || '')}" title="Copy code" aria-label="Copy pairing code">
                    Copy
                  </button>
                </div>
                <button class="btn btn-primary btn-sm pairing-quick-approve">
                  Approve
                </button>
              </div>
            `;
          });
        }
      }

      if (total === 0) {
        html = `
          <div class="pairing-empty">
            <div class="empty-title">No pending requests</div>
            <div class="empty-hint">When users message your bot with DM policy set to "pairing", their codes will appear here for approval.</div>
          </div>
        `;
      }

      setHtml(this.listEl, html);
      this.updateBadge(total);

      // Attach event handlers
      this.listEl.querySelectorAll('.pairing-quick-approve').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const item = e.target.closest('.pairing-item');
          if (item) {
            this.approve(item.dataset.channel, item.dataset.code, item);
          }
        });
      });
      
      this.listEl.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.copyCode(btn.dataset.code, btn);
        });
      });
    },
    
    async copyCode(code, btn) {
      try {
        await navigator.clipboard.writeText(code);
        btn.classList.add('copied');
        btn.textContent = 'Copied';
        Toast.success(`Code ${code} copied to clipboard`);
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.textContent = 'Copy';
        }, 2000);
      } catch (e) {
        // Fallback for browsers without clipboard API
        const input = document.createElement('input');
        input.value = code;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
        Toast.success(`Code ${code} copied`);
      }
    },
    
    formatTimeAgo(timestamp) {
      if (!timestamp) return '';
      const now = Date.now();
      const then = new Date(timestamp).getTime();
      const diff = Math.floor((now - then) / 1000);
      
      if (diff < 60) return 'just now';
      if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
      if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
      return `${Math.floor(diff / 86400)}d ago`;
    },
    
    escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    },

    async approve(channel, code, itemEl = null) {
      if (itemEl) {
        itemEl.classList.add('approving');
        const btn = itemEl.querySelector('.pairing-quick-approve');
        if (btn) btn.textContent = 'Approving...';
      }
      
      show(this.outEl);
      setText(this.outEl, `Approving ${channel} / ${code}...`);

      try {
        const result = await API.post('/setup/api/pairing/approve', { channel, code });
        
        if (result.ok) {
          Toast.success(`User approved for ${channel}`, 'Pairing Approved');
          if (itemEl) {
            itemEl.classList.remove('approving');
            itemEl.classList.add('approved');
            const btn = itemEl.querySelector('.pairing-quick-approve');
            if (btn) {
              btn.textContent = 'Approved';
              btn.disabled = true;
            }
            // Remove item after animation
            setTimeout(() => {
              itemEl.style.opacity = '0';
              itemEl.style.transform = 'translateX(20px)';
              setTimeout(() => itemEl.remove(), 200);
              // Update count
              this.updateBadge(this.pendingCount - 1);
            }, 1500);
          }
          setText(this.outEl, `Approved successfully!\n${result.output || ''}`);
        } else {
          throw new Error(result.output || result.error || 'Approval failed');
        }
      } catch (e) {
        Toast.error(e.message, 'Approval Failed');
        setText(this.outEl, `Error: ${e.message}`);
        if (itemEl) {
          itemEl.classList.remove('approving');
          const btn = itemEl.querySelector('.pairing-quick-approve');
          if (btn) btn.textContent = 'Retry';
        }
      }
    },

    approveManual() {
      const channel = $('#pairingChannel')?.value;
      const code = ($('#pairingCode')?.value || '').trim().toUpperCase();
      
      if (!code) {
        Toast.warning('Please enter an 8-character pairing code');
        $('#pairingCode')?.focus();
        return;
      }
      
      if (code.length !== 8) {
        Toast.warning('Pairing code must be exactly 8 characters');
        $('#pairingCode')?.focus();
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
        Toast.info('Auto-refresh enabled (every 10s)');
      } else {
        Toast.info('Auto-refresh disabled');
      }
    }
  };

  // Config editor for raw JSON.
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
        Toast.error(e.message, 'Failed to load config');
      }
    },

    async save() {
      if (!confirm('Save config and restart gateway?')) return;

      show(this.outEl);
      setText(this.outEl, 'Saving...');

      try {
        const result = await API.post('/setup/api/config/raw', { content: this.textEl.value });
        if (result.ok) {
          setText(this.outEl, `Saved: ${result.path}\nGateway restarted.`);
          Toast.success('Configuration saved and gateway restarted.');
        } else {
          setText(this.outEl, `Error: ${result.error}`);
          Toast.error(result.error, 'Save Failed');
        }
        Status.refresh();
      } catch (e) {
        setText(this.outEl, `Error: ${e.message}`);
        Toast.error(e.message, 'Save Failed');
      }
    }
  };

  // Console terminal emulator.
  const CONSOLE_COMMANDS = [
    'gateway.restart', 'gateway.stop', 'gateway.start', 'gateway.health', 'gateway.reset-breaker',
    'openclaw.version', 'openclaw.status', 'openclaw.health', 'openclaw.doctor',
    'openclaw.logs.tail', 'openclaw.config.get', 'openclaw.config.set',
    'openclaw.pairing.list', 'openclaw.pairing.approve',
    'openclaw.nodes.list', 'openclaw.nodes.approve',
    'openclaw.channels.status', 'openclaw.security.audit',
    'openclaw.devices.list', 'openclaw.devices.clear', 'openclaw.devices.approve',
  ];

  const CONSOLE_HELP = {
    'Gateway': ['gateway.restart', 'gateway.stop', 'gateway.start', 'gateway.health', 'gateway.reset-breaker'],
    'Status': ['openclaw.version', 'openclaw.status', 'openclaw.health', 'openclaw.doctor'],
    'Logs & Config': ['openclaw.logs.tail', 'openclaw.config.get', 'openclaw.config.set'],
    'Pairing': ['openclaw.pairing.list', 'openclaw.pairing.approve'],
    'Nodes': ['openclaw.nodes.list', 'openclaw.nodes.approve'],
    'Channels': ['openclaw.channels.status'],
    'Security': ['openclaw.security.audit'],
    'Devices': ['openclaw.devices.list', 'openclaw.devices.clear', 'openclaw.devices.approve'],
  };

  const Console = {
    outputEl: null,
    inputEl: null,
    suggestionsEl: null,
    history: [],
    historyIndex: -1,
    savedInput: '',
    running: false,
    tabMatches: [],
    tabIndex: -1,
    tabPrefix: '',

    init() {
      this.outputEl = $('#consoleOut');
      this.inputEl = $('#consoleInput');
      this.suggestionsEl = $('#consoleSuggestions');

      try {
        this.history = JSON.parse(sessionStorage.getItem('console-history') || '[]');
      } catch { this.history = []; }

      if (this.inputEl) {
        this.inputEl.addEventListener('keydown', (e) => this.handleKey(e));
        this.inputEl.addEventListener('input', () => {
          this.tabMatches = [];
          this.tabIndex = -1;
          this.updateSuggestions();
        });
      }

      // Click on terminal focuses input
      $('#terminalContainer')?.addEventListener('click', (e) => {
        if (e.target.closest('.terminal-suggestions')) return;
        this.inputEl?.focus();
      });

      this.appendInfo('OpenClaw Console \u2014 type "help" for commands, Tab to autocomplete');
    },

    handleKey(e) {
      switch (e.key) {
        case 'Enter':
          e.preventDefault();
          this.run();
          break;
        case 'Tab':
          e.preventDefault();
          this.autocomplete();
          break;
        case 'ArrowUp':
          e.preventDefault();
          this.historyBack();
          break;
        case 'ArrowDown':
          e.preventDefault();
          this.historyForward();
          break;
        case 'Escape':
          this.inputEl.value = '';
          this.hideSuggestions();
          break;
      }
    },

    async run() {
      const raw = (this.inputEl?.value || '').trim();
      if (!raw || this.running) return;

      // Push to history (deduplicate consecutive)
      if (this.history[this.history.length - 1] !== raw) {
        this.history.push(raw);
        if (this.history.length > 50) this.history.shift();
        try { sessionStorage.setItem('console-history', JSON.stringify(this.history)); } catch {}
      }
      this.historyIndex = -1;
      this.savedInput = '';
      this.inputEl.value = '';
      this.hideSuggestions();

      this.appendCmd(raw);

      // Built-in commands
      if (raw === 'help' || raw === '?') { this.showHelp(); return; }
      if (raw === 'clear') { this.outputEl.replaceChildren(); return; }

      // Parse command and argument
      const spaceIdx = raw.indexOf(' ');
      const cmd = spaceIdx > -1 ? raw.substring(0, spaceIdx) : raw;
      const arg = spaceIdx > -1 ? raw.substring(spaceIdx + 1).trim() : '';

      if (!CONSOLE_COMMANDS.includes(cmd)) {
        this.appendError('Unknown command: ' + cmd);
        this.appendInfo('Type "help" for available commands.');
        return;
      }

      this.running = true;
      this.appendInfo('Running...');

      try {
        const result = await API.post('/setup/api/console/run', { cmd, arg });
        const output = result.output || JSON.stringify(result, null, 2);
        if (result.ok) {
          this.appendSuccess(output);
        } else {
          this.appendError(output);
        }
        Status.refresh();
      } catch (e) {
        this.appendError('Error: ' + e.message);
      } finally {
        this.running = false;
      }
    },

    // DOM output helpers — safe, no innerHTML
    appendLine(text, className) {
      const div = document.createElement('div');
      div.textContent = text;
      if (className) div.className = className;
      this.outputEl.appendChild(div);
      this.outputEl.scrollTop = this.outputEl.scrollHeight;
    },
    appendCmd(text) { this.appendLine('$ ' + text, 'cmd-echo'); },
    appendSuccess(text) { this.appendLine(text, 'cmd-success'); },
    appendError(text) { this.appendLine(text, 'cmd-error'); },
    appendInfo(text) { this.appendLine(text, 'cmd-info'); },

    // Autocomplete with Tab cycling
    autocomplete() {
      const val = this.inputEl.value;

      // Start new tab-completion if prefix changed
      if (val !== this.tabPrefix || this.tabMatches.length === 0) {
        this.tabPrefix = val;
        this.tabMatches = CONSOLE_COMMANDS.filter(c => c.startsWith(val));
        this.tabIndex = -1;
      }

      if (this.tabMatches.length === 0) return;

      this.tabIndex = (this.tabIndex + 1) % this.tabMatches.length;
      this.inputEl.value = this.tabMatches[this.tabIndex];
      this.updateSuggestions();
    },

    updateSuggestions() {
      const val = this.inputEl.value;
      this.suggestionsEl.replaceChildren();

      if (!val) {
        this.suggestionsEl.hidden = true;
        return;
      }

      const matches = CONSOLE_COMMANDS.filter(c => c.startsWith(val));
      if (matches.length === 0 || (matches.length === 1 && matches[0] === val)) {
        this.suggestionsEl.hidden = true;
        return;
      }

      for (const cmd of matches) {
        const div = document.createElement('div');
        div.className = 'suggestion';
        div.textContent = cmd;
        if (cmd === this.inputEl.value) div.className += ' active';
        div.addEventListener('click', () => {
          this.inputEl.value = cmd;
          this.hideSuggestions();
          this.inputEl.focus();
        });
        this.suggestionsEl.appendChild(div);
      }
      this.suggestionsEl.hidden = false;
    },

    hideSuggestions() {
      if (this.suggestionsEl) {
        this.suggestionsEl.hidden = true;
        this.suggestionsEl.replaceChildren();
      }
    },

    historyBack() {
      if (this.history.length === 0) return;
      if (this.historyIndex === -1) {
        this.savedInput = this.inputEl.value;
        this.historyIndex = this.history.length - 1;
      } else if (this.historyIndex > 0) {
        this.historyIndex--;
      }
      this.inputEl.value = this.history[this.historyIndex];
    },

    historyForward() {
      if (this.historyIndex === -1) return;
      if (this.historyIndex < this.history.length - 1) {
        this.historyIndex++;
        this.inputEl.value = this.history[this.historyIndex];
      } else {
        this.historyIndex = -1;
        this.inputEl.value = this.savedInput;
      }
    },

    showHelp() {
      this.appendInfo('Available commands:');
      for (const [group, cmds] of Object.entries(CONSOLE_HELP)) {
        this.appendInfo('');
        this.appendInfo('  ' + group + ':');
        for (const c of cmds) {
          this.appendInfo('    ' + c);
        }
      }
      this.appendInfo('');
      this.appendInfo('Built-in:');
      this.appendInfo('  help, ?     Show this help');
      this.appendInfo('  clear       Clear terminal output');
      this.appendInfo('');
      this.appendInfo('Usage: command [argument]');
      this.appendInfo('  e.g. openclaw.logs.tail 200');
      this.appendInfo('       openclaw.config.get gateway.auth');
    },
  };

  // Backup import flow.
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
        Toast.warning('Please select a .tar.gz backup file first.');
        return;
      }

      if (!confirm('Import backup? This will overwrite your current configuration and data under /data.')) return;

      show(this.outEl);
      setText(this.outEl, `Uploading ${file.name} (${(file.size / 1024).toFixed(1)} KB)...`);

      try {
        const buf = await file.arrayBuffer();
        const text = await API.postRaw('/setup/import', buf, 'application/gzip');
        setText(this.outEl, text);
        Toast.success('Backup imported successfully! Gateway has been restarted.');
        Status.refresh();
      } catch (e) {
        setText(this.outEl, `Error: ${e.message}`);
        Toast.error(e.message, 'Import Failed');
      }
    }
  };

  // App bootstrap.
  document.addEventListener('DOMContentLoaded', () => {
    Toast.init();
    Tabs.init();
    Collapsible.init();
    Auth.init();
    Status.init();
    Setup.init();
    Pairing.init();
    Config.init();
    Console.init();
    Backup.init();
    
    // Show welcome message on first load
    if (!sessionStorage.getItem('welcomed')) {
      sessionStorage.setItem('welcomed', '1');
      setTimeout(() => {
        Toast.info('Configure your AI provider and channels, then approve users via the Pairing tab.', 'Welcome to OpenClaw Setup');
      }, 500);
    }
  });
})();
