#!/usr/bin/env node

const TELEGRAM_API_BASE = "https://api.telegram.org/bot";
const COINGECKO_PRICE_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=";

const DEFAULT_CURRENCY = "usd";
const DEFAULT_POLL_SECONDS = 60;
const MIN_POLL_SECONDS = 15;

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function getPositiveIntegerEnv(name, defaultValue) {
  const rawValue = process.env[name];
  if (!rawValue) {
    return defaultValue;
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function normalizeCurrency(value) {
  return (value || DEFAULT_CURRENCY).trim().toLowerCase();
}

function formatPrice(price, currency) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    maximumFractionDigits: 2,
  }).format(price);
}

function parseWatchCommand(text, defaultCurrency) {
  const [, direction, target, currency] = text.trim().split(/\s+/);
  const normalizedDirection = direction && direction.toLowerCase();
  const parsedTarget = Number(target);

  if (!["above", "below"].includes(normalizedDirection)) {
    throw new Error("Use `/watch above <price>` or `/watch below <price>`.");
  }

  if (!Number.isFinite(parsedTarget) || parsedTarget <= 0) {
    throw new Error("Watch price must be a positive number.");
  }

  return {
    direction: normalizedDirection,
    target: parsedTarget,
    currency: normalizeCurrency(currency || defaultCurrency),
    triggered: false,
  };
}

async function telegramApi(token, method, payload) {
  const response = await fetch(`${TELEGRAM_API_BASE}${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.description || `Telegram ${method} failed`);
  }

  return data.result;
}

async function sendMessage(token, chatId, text) {
  return telegramApi(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
}

async function getUpdates(token, offset, timeoutSeconds = 30) {
  return telegramApi(token, "getUpdates", {
    offset,
    timeout: timeoutSeconds,
    allowed_updates: ["message"],
  });
}

async function fetchEthPrice(currency) {
  const response = await fetch(`${COINGECKO_PRICE_URL}${encodeURIComponent(currency)}`, {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`CoinGecko returned HTTP ${response.status}`);
  }

  const data = await response.json();
  const price = data.ethereum && data.ethereum[currency];
  if (!Number.isFinite(price)) {
    throw new Error(`ETH price unavailable for currency: ${currency}`);
  }

  return price;
}

function renderHelp(defaultCurrency) {
  return [
    "*ETH monitor bot*",
    "",
    "Commands:",
    "`/price` - show current ETH price",
    "`/watch above <price> [currency]` - alert when ETH crosses up",
    "`/watch below <price> [currency]` - alert when ETH crosses down",
    "`/status` - show active alert",
    "`/unwatch` - clear active alert",
    "`/help` - show this help",
    "",
    `Default currency: ${defaultCurrency.toUpperCase()}`,
  ].join("\n");
}

function createBot({ token, allowedChatId, defaultCurrency, pollSeconds }) {
  const watches = new Map();

  function isAllowed(chatId) {
    return !allowedChatId || String(chatId) === String(allowedChatId);
  }

  async function rejectUnauthorized(chatId) {
    if (!isAllowed(chatId)) {
      await sendMessage(token, chatId, "This bot is restricted to another chat.");
      return true;
    }

    return false;
  }

  async function handleMessage(message) {
    if (!message.text || !message.chat) {
      return;
    }

    const chatId = message.chat.id;
    if (await rejectUnauthorized(chatId)) {
      return;
    }

    const text = message.text.trim();
    const command = text.split(/\s+/, 1)[0].split("@", 1)[0].toLowerCase();

    if (command === "/start" || command === "/help") {
      await sendMessage(token, chatId, renderHelp(defaultCurrency));
      return;
    }

    if (command === "/price") {
      const price = await fetchEthPrice(defaultCurrency);
      await sendMessage(
        token,
        chatId,
        `ETH is ${formatPrice(price, defaultCurrency)}.`,
      );
      return;
    }

    if (command === "/watch") {
      try {
        const watch = parseWatchCommand(text, defaultCurrency);
        watches.set(String(chatId), watch);
        await sendMessage(
          token,
          chatId,
          `Watching ETH ${watch.direction} ${formatPrice(watch.target, watch.currency)}. Checking every ${pollSeconds}s.`,
        );
      } catch (error) {
        await sendMessage(token, chatId, error.message);
      }
      return;
    }

    if (command === "/status") {
      const watch = watches.get(String(chatId));
      if (!watch) {
        await sendMessage(token, chatId, "No active ETH alert. Use `/watch` to create one.");
        return;
      }

      await sendMessage(
        token,
        chatId,
        `Active alert: ETH ${watch.direction} ${formatPrice(watch.target, watch.currency)}.`,
      );
      return;
    }

    if (command === "/unwatch") {
      watches.delete(String(chatId));
      await sendMessage(token, chatId, "ETH alert cleared.");
      return;
    }

    await sendMessage(token, chatId, "Unknown command. Use `/help`.");
  }

  async function checkWatches() {
    for (const [chatId, watch] of watches.entries()) {
      try {
        const price = await fetchEthPrice(watch.currency);
        const crossed =
          (watch.direction === "above" && price >= watch.target) ||
          (watch.direction === "below" && price <= watch.target);

        if (crossed && !watch.triggered) {
          watch.triggered = true;
          await sendMessage(
            token,
            chatId,
            `ETH alert: ${formatPrice(price, watch.currency)} is ${watch.direction} ${formatPrice(watch.target, watch.currency)}.`,
          );
        }

        if (!crossed && watch.triggered) {
          watch.triggered = false;
        }
      } catch (error) {
        console.error(`Watch check failed for chat ${chatId}: ${error.message}`);
      }
    }
  }

  async function start() {
    let offset = 0;
    console.log(`ETH Telegram monitor started. Poll interval: ${pollSeconds}s.`);

    setInterval(() => {
      checkWatches().catch((error) => {
        console.error(`Watch check failed: ${error.message}`);
      });
    }, pollSeconds * 1000);

    while (true) {
      try {
        const updates = await getUpdates(token, offset);
        for (const update of updates) {
          offset = update.update_id + 1;
          await handleMessage(update.message || {});
        }
      } catch (error) {
        console.error(`Polling failed: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  return { handleMessage, checkWatches, start, watches };
}

function loadConfig() {
  const token = getRequiredEnv("TELEGRAM_BOT_TOKEN");
  const defaultCurrency = normalizeCurrency(process.env.ETH_PRICE_CURRENCY);
  const configuredPollSeconds = getPositiveIntegerEnv(
    "ETH_PRICE_POLL_SECONDS",
    DEFAULT_POLL_SECONDS,
  );

  return {
    token,
    allowedChatId: process.env.TELEGRAM_ALLOWED_CHAT_ID,
    defaultCurrency,
    pollSeconds: Math.max(configuredPollSeconds, MIN_POLL_SECONDS),
  };
}

async function main() {
  try {
    const bot = createBot(loadConfig());
    await bot.start();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  createBot,
  fetchEthPrice,
  formatPrice,
  parseWatchCommand,
};
