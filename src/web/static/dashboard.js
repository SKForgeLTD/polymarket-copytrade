/**
 * Dashboard JavaScript using lit-html
 */

const { html, render } = window;

// Application state
const state = {
  status: null,
  trades: [],
  error: null,
  loading: true,
  connected: false,
  lastUpdate: null,
  uptime: null,
  nextPollCountdown: 0,
};

// EventSource for real-time updates
let eventSource = null;

// Audio context for sound notifications
let audioContext = null;

/**
 * Sound Manager - Classic OS notification sounds (macOS/Windows XP style)
 */
const SoundManager = {
  volume: 0.2, // 20% volume

  /**
   * Initialize audio context (requires user interaction)
   */
  init() {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    // Resume context if suspended (browser autoplay policy)
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }
  },

  /**
   * Play a smooth note (sine wave for classic OS sound)
   */
  playNote(frequency, duration, startTime = 0) {
    if (!audioContext) return;

    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.type = 'sine'; // Smooth sine wave for classic OS feel
    oscillator.frequency.value = frequency;

    const now = audioContext.currentTime + startTime;

    // Smooth envelope (attack-decay-sustain-release)
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(this.volume, now + 0.015);
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + duration);

    oscillator.start(now);
    oscillator.stop(now + duration);
  },

  /**
   * Play a chord (multiple notes simultaneously)
   */
  playChord(frequencies, duration, startTime = 0) {
    for (const freq of frequencies) {
      this.playNote(freq, duration, startTime);
    }
  },

  /**
   * Target detected - Glass (like macOS "Glass")
   * High gentle ding
   */
  targetDetected() {
    this.playNote(1318.51, 0.3); // E6 - clear, high ping
  },

  /**
   * Copy executed - Success chord (like Windows XP "Windows Notify")
   * Ascending major chord
   */
  copyExecuted() {
    // C major chord ascending
    this.playNote(523.25, 0.15, 0); // C5
    this.playNote(659.25, 0.2, 0.06); // E5
    this.playNote(783.99, 0.35, 0.12); // G5
  },

  /**
   * Copy failed - Error (like Windows XP "Critical Stop")
   * Low warning tone
   */
  copyFailed() {
    // Dissonant interval
    this.playChord([493.88, 466.16], 0.25, 0); // B4 + Bb4 together
    this.playNote(392.0, 0.35, 0.15); // G4 - resolution down
  },

  /**
   * Circuit breaker - Alert (like macOS "Basso")
   * Deep warning sound
   */
  circuitBreaker() {
    this.playNote(220.0, 0.4, 0); // A3 - deep
    this.playNote(220.0, 0.4, 0.35); // A3 - repeat
  },

  /**
   * Connection change - Simple notification
   */
  connectionChange(connected) {
    if (connected) {
      // Quick ascending interval (reconnected)
      this.playNote(659.25, 0.12, 0); // E5
      this.playNote(783.99, 0.2, 0.08); // G5
    } else {
      // Single low tone (disconnected)
      this.playNote(329.63, 0.25); // E4
    }
  },
};

/**
 * Initialize dashboard
 */
async function init() {
  // Initialize audio on first user interaction
  document.addEventListener('click', () => SoundManager.init(), { once: true });
  document.addEventListener('keydown', () => SoundManager.init(), { once: true });
  console.log('Initializing dashboard...');

  // Fetch initial data
  await fetchStatus();
  await fetchRecentTrades();

  // Connect to SSE for real-time updates
  connectSSE();

  // Render initial state
  renderApp();

  // Update poll countdown every second
  setInterval(() => {
    updatePollCountdown();
    renderApp();
  }, 1000);

  // Auto-refresh every 30 seconds as backup
  setInterval(() => {
    if (!state.connected) {
      fetchStatus();
    }
  }, 30000);
}

/**
 * Update countdown to next poll
 */
function updatePollCountdown() {
  if (!state.status || !state.status.monitoring) return;

  const { monitoring } = state.status;
  if (!monitoring.pollingActive) {
    state.nextPollCountdown = 0;
    return;
  }

  const lastPollTime = new Date(monitoring.lastPollTime).getTime();
  const nextPollTime = lastPollTime + monitoring.pollIntervalSeconds * 1000;
  const now = Date.now();
  const secondsUntilNextPoll = Math.max(0, Math.ceil((nextPollTime - now) / 1000));

  state.nextPollCountdown = secondsUntilNextPoll;
}

/**
 * Fetch status from API
 */
async function fetchStatus() {
  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.status = await response.json();
    state.lastUpdate = Date.now();
    state.loading = false;
    state.error = null;
    renderApp();
  } catch (error) {
    console.error('Failed to fetch status:', error);
    state.error = `Failed to fetch status: ${error.message}`;
    state.loading = false;
    renderApp();
  }
}

/**
 * Fetch recent trades
 */
async function fetchRecentTrades() {
  try {
    const response = await fetch('/api/trades/recent?limit=100');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.trades = data.trades || [];
    renderApp();
  } catch (error) {
    console.error('Failed to fetch trades:', error);
  }
}

/**
 * Connect to SSE
 */
function connectSSE() {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource('/api/events');

  eventSource.addEventListener('connected', () => {
    console.log('SSE connected');
    state.connected = true;
    renderApp();
  });

  eventSource.addEventListener('status_update', (event) => {
    const data = JSON.parse(event.data);
    // Merge monitoring status into existing status
    if (state.status && data.monitoring) {
      state.status.monitoring = data.monitoring;
      state.lastUpdate = Date.now();
      renderApp();
    }
  });

  eventSource.addEventListener('trade_detected', (event) => {
    const data = JSON.parse(event.data);
    addTradeToHistory({
      ...data,
      type: 'target_detected',
      timestamp: Date.now(),
    });
    SoundManager.targetDetected();
    renderApp();
  });

  eventSource.addEventListener('trade_executed', (event) => {
    const data = JSON.parse(event.data);
    addTradeToHistory({
      ...data,
      type: 'copy_executed',
      timestamp: Date.now(),
    });
    SoundManager.copyExecuted();
    renderApp();
  });

  eventSource.addEventListener('trade_failed', (event) => {
    const data = JSON.parse(event.data);
    addTradeToHistory({
      ...data,
      type: 'copy_failed',
      timestamp: Date.now(),
    });
    SoundManager.copyFailed();
    renderApp();
  });

  eventSource.addEventListener('circuit_breaker', (event) => {
    const data = JSON.parse(event.data);
    console.log('Circuit breaker event:', data);
    SoundManager.circuitBreaker();
    fetchStatus(); // Refresh full status
  });

  eventSource.addEventListener('uptime', (event) => {
    const data = JSON.parse(event.data);
    state.uptime = data.uptimeFormatted;
    renderApp();
  });

  eventSource.onerror = (error) => {
    console.error('SSE error:', error);
    state.connected = false;
    renderApp();

    // Reconnect after 5 seconds
    setTimeout(() => {
      console.log('Reconnecting SSE...');
      connectSSE();
    }, 5000);
  };
}

/**
 * Add trade to history (circular buffer)
 */
function addTradeToHistory(trade) {
  state.trades.unshift(trade);
  if (state.trades.length > 100) {
    state.trades.pop();
  }
}

/**
 * Format timestamp
 */
function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { hour12: false });
}

/**
 * Format duration
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Format currency
 */
function formatUSD(value) {
  return `$${value.toFixed(2)}`;
}

/**
 * Format percentage
 */
function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Render main app
 */
function renderApp() {
  const app = document.getElementById('app');

  if (state.loading) {
    render(
      html`
      <div class="container">
        <div class="loading">Loading dashboard</div>
      </div>
    `,
      app
    );
    return;
  }

  if (state.error) {
    render(
      html`
      <div class="container">
        <div class="error-message">${state.error}</div>
      </div>
    `,
      app
    );
    return;
  }

  if (!state.status) {
    render(
      html`
      <div class="container">
        <div class="error-message">No data available</div>
      </div>
    `,
      app
    );
    return;
  }

  render(
    html`
    <div class="container fade-in">
      ${renderHeader()}
      ${renderMetrics()}
      ${renderOperationsLog()}
      ${renderFooter()}
    </div>
  `,
    app
  );
}

/**
 * Render header
 */
function renderHeader() {
  const { bot } = state.status;
  const isRunning = bot.isRunning;

  return html`
    <div class="header">
      <h1>
        POLYMARKET COPYTRADE MONITOR
        ${isRunning ? html`<span class="live-indicator">● LIVE</span>` : ''}
      </h1>
      <div class="subtitle">
        ${state.connected ? '⚡ Real-time' : '⚠ Polling'} │
        Updated: ${state.lastUpdate ? formatTime(state.lastUpdate) : 'Never'} │
        Uptime: ${state.uptime || formatDuration(bot.uptime)}
      </div>
    </div>
  `;
}

/**
 * Render metrics grid
 */
function renderMetrics() {
  return html`
    <div class="metrics-grid">
      ${renderBalanceCard()}
      ${renderPositionsCard()}
      ${renderRiskCard()}
      ${renderMonitoringCard()}
      ${renderPerformanceCard()}
      ${renderQueueCard()}
    </div>
  `;
}

/**
 * Render balance card
 */
function renderBalanceCard() {
  const { balance } = state.status;

  return html`
    <div class="card">
      <div class="card-title">Balance</div>
      <div class="card-content">
        <div class="large-value">${formatUSD(balance.total)}</div>
        <div class="metric-row">
          <span class="metric-label">Available</span>
          <span class="metric-value value-success">${formatUSD(balance.available)}</span>
        </div>
        <div class="metric-row">
          <span class="metric-label">In Positions</span>
          <span class="metric-value value-info">${formatUSD(balance.inPositions)}</span>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render positions card
 */
function renderPositionsCard() {
  const { positions } = state.status;

  return html`
    <div class="card">
      <div class="card-title">Positions</div>
      <div class="card-content">
        <div class="metric-row">
          <span class="metric-label">User Positions</span>
          <span class="metric-value value-success">${positions.user.count}</span>
        </div>
        <div class="metric-row">
          <span class="metric-label">User Value</span>
          <span class="metric-value value-success">${formatUSD(positions.user.totalValue)}</span>
        </div>
        <div class="metric-row">
          <span class="metric-label">Target Positions</span>
          <span class="metric-value value-info">${positions.target.count}</span>
        </div>
        <div class="metric-row">
          <span class="metric-label">Target Value</span>
          <span class="metric-value value-info">${formatUSD(positions.target.totalValue)}</span>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render risk card
 */
function renderRiskCard() {
  const { risk } = state.status;
  const { circuitBreaker } = risk;

  return html`
    <div class="card">
      <div class="card-title">Risk Management</div>
      <div class="card-content">
        <div class="metric-row">
          <span class="metric-label">Circuit Breaker</span>
          <span class="metric-value">
            ${
              circuitBreaker.isTripped
                ? html`<span class="badge badge-error">ACTIVE</span>`
                : html`<span class="badge badge-success">OK</span>`
            }
          </span>
        </div>
        <div class="metric-row">
          <span class="metric-label">Consecutive Failures</span>
          <span class="metric-value ${circuitBreaker.consecutiveFailures > 3 ? 'value-warning' : 'value-success'}">
            ${circuitBreaker.consecutiveFailures}
          </span>
        </div>
        <div class="metric-row">
          <span class="metric-label">Trading Allowed</span>
          <span class="metric-value">
            ${
              risk.tradingAllowed
                ? html`<span class="badge badge-success">YES</span>`
                : html`<span class="badge badge-error">NO</span>`
            }
          </span>
        </div>
        <div class="metric-row">
          <span class="metric-label">Portfolio Exposure</span>
          <span class="metric-value ${risk.exposure > 0.8 ? 'value-warning' : 'value-success'}">
            ${formatPercent(risk.exposure)}
          </span>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render monitoring card
 */
function renderMonitoringCard() {
  const { monitoring } = state.status;
  const nextPollCountdown = state.nextPollCountdown || 0;

  return html`
    <div class="card">
      <div class="card-title">Monitoring</div>
      <div class="card-content">
        <div class="metric-row">
          <span class="metric-label">Status</span>
          <span class="metric-value">
            ${
              monitoring.isActive
                ? html`<span class="badge badge-success">ACTIVE</span>`
                : html`<span class="badge badge-error">INACTIVE</span>`
            }
          </span>
        </div>
        <div class="metric-row">
          <span class="metric-label">Polling</span>
          <span class="metric-value">
            ${
              monitoring.pollingActive
                ? html`<span class="badge badge-success">Every ${monitoring.pollIntervalSeconds}s</span>`
                : html`<span class="badge badge-warning">INACTIVE</span>`
            }
          </span>
        </div>
        <div class="metric-row">
          <span class="metric-label">Next Poll</span>
          <span class="metric-value ${nextPollCountdown <= 3 ? 'value-warning' : ''}">
            ${nextPollCountdown}s
          </span>
        </div>
        <div class="metric-row">
          <span class="metric-label">Last Poll</span>
          <span class="metric-value value-dim" style="font-size: 10px;">
            ${new Date(monitoring.lastPollTime).toLocaleTimeString()}
          </span>
        </div>
        <div class="metric-row">
          <span class="metric-label">Target</span>
          <span class="metric-value value-dim" style="font-size: 10px;">
            ${monitoring.targetAddress.substring(0, 10)}...
          </span>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render performance card
 */
function renderPerformanceCard() {
  const { performance } = state.status;
  const { metrics } = performance;

  return html`
    <div class="card">
      <div class="card-title">Performance</div>
      <div class="card-content">
        <div class="metric-row">
          <span class="metric-label">Trades Processed</span>
          <span class="metric-value value-success">${metrics.tradesProcessed}</span>
        </div>
        <div class="metric-row">
          <span class="metric-label">Trades Failed</span>
          <span class="metric-value ${metrics.tradesFailed > 0 ? 'value-error' : 'value-dim'}">
            ${metrics.tradesFailed}
          </span>
        </div>
        <div class="metric-row">
          <span class="metric-label">Success Rate</span>
          <span class="metric-value ${metrics.successRate >= 0.9 ? 'value-success' : 'value-warning'}">
            ${formatPercent(metrics.successRate)}
          </span>
        </div>
        <div class="metric-row">
          <span class="metric-label">Avg Latency</span>
          <span class="metric-value value-info">${performance.latency.avg.toFixed(0)}ms</span>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render queue card
 */
function renderQueueCard() {
  const { performance } = state.status;
  const { queue } = performance;
  const queueUtilization = queue.length / queue.maxSize;

  return html`
    <div class="card">
      <div class="card-title">Queue Status</div>
      <div class="card-content">
        <div class="metric-row">
          <span class="metric-label">Queue Length</span>
          <span class="metric-value ${queue.length > 50 ? 'value-warning' : 'value-success'}">
            ${queue.length}
          </span>
        </div>
        <div class="metric-row">
          <span class="metric-label">Processing</span>
          <span class="metric-value value-info">${queue.processing}</span>
        </div>
        <div class="metric-row">
          <span class="metric-label">Utilization</span>
          <span class="metric-value ${queueUtilization > 0.8 ? 'value-warning' : 'value-success'}">
            ${formatPercent(queueUtilization)}
          </span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${queueUtilization * 100}%"></div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render operations log
 */
function renderOperationsLog() {
  const trades = state.trades.slice(0, 50); // Show last 50

  return html`
    <div class="operations-log">
      <div class="card-title">Recent Operations</div>
      ${
        trades.length === 0
          ? html`<div style="color: #006600; text-align: center; padding: 20px;">No operations yet</div>`
          : trades.map((trade) => renderLogEntry(trade))
      }
    </div>
  `;
}

/**
 * Render single log entry
 */
function renderLogEntry(trade) {
  let typeLabel, typeClass, icon;

  switch (trade.type) {
    case 'target_detected':
      typeLabel = 'TARGET';
      typeClass = 'badge-info';
      icon = '📥';
      break;
    case 'copy_executed':
      typeLabel = 'EXECUTED';
      typeClass = 'badge-success';
      icon = '✅';
      break;
    case 'copy_failed':
      typeLabel = 'FAILED';
      typeClass = 'badge-error';
      icon = '❌';
      break;
    default:
      typeLabel = 'UNKNOWN';
      typeClass = 'badge-info';
      icon = '❓';
  }

  // Use readable market name (title > slug > short hash)
  const marketName =
    trade.title ||
    trade.slug ||
    (trade.market
      ? `${trade.market.substring(0, 6)}...${trade.market.substring(trade.market.length - 4)}`
      : 'Unknown');

  // Truncate long market names
  const marketDisplay = marketName.length > 60 ? marketName.substring(0, 57) + '...' : marketName;

  return html`
    <div class="log-entry">
      <span class="log-timestamp">${formatTime(trade.timestamp)}</span>
      <span class="log-type">
        <span class="badge ${typeClass}">${icon} ${typeLabel}</span>
      </span>
      <span class="log-message">
        ${trade.icon ? html`<img src="${trade.icon}" alt="" style="width: 16px; height: 16px; vertical-align: middle; margin-right: 4px;" />` : ''}
        ${marketDisplay}
        ${trade.outcome ? ` - ${trade.outcome}` : ''} │
        ${trade.side} ${trade.size.toFixed(2)} @ ${trade.price.toFixed(4)} │
        ${formatUSD(trade.value)}
        ${trade.latencyMs ? ` │ ${trade.latencyMs}ms` : ''}
      </span>
      ${trade.error ? html`<div class="log-error">Error: ${trade.error}</div>` : ''}
    </div>
  `;
}

/**
 * Render footer
 */
function renderFooter() {
  return html`
    <div class="footer">
      POLYMARKET COPYTRADE BOT │ PRODUCTION GRADE MONITORING SYSTEM │
      ${new Date().getFullYear()}
    </div>
  `;
}

// Initialize on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
