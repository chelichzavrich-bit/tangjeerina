# Танг Джи Рина — Telegram-бот на Vercel + Gemini (бесплатно)

## 1. Ключи
- Telegram: @BotFather → `/newbot` → токен.
- Gemini: https://aistudio.google.com/apikey → Create API key (карта не нужна).

## 2. Переменные в Vercel
Project → Settings → Environment Variables (для **Production**), затем **Redeploy**:

| Переменная | Значение |
|---|---|
| TELEGRAM_BOT_TOKEN | токен BotFather |
| GEMINI_API_KEY | ключ AI Studio |
| CRON_SECRET | случайная строка, 16+ символов |
| CRON_CHAT_ID | ID чата для проактивных сообщений (узнать: @userinfobot) |
| WEBHOOK_SECRET | (необязательно) строка из букв/цифр |
| BOT_USERNAME | (необязательно) username бота без @, для групп |
| GEMINI_MODEL | (необязательно) своё имя модели |

## 3. Установка вебхука (один раз, подставь свои значения)
```
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<твой-проект>.vercel.app/api/webhook&secret_token=<WEBHOOK_SECRET>"
```
Без WEBHOOK_SECRET просто убери `&secret_token=...`.
Проверка: `https://api.telegram.org/bot<TOKEN>/getWebhookInfo` — поле `last_error_message` должно быть пустым.

Важно: используй **production-домен** (`xxx.vercel.app`), а не preview-ссылку — на preview включена Deployment Protection, и Telegram получит 401.

## 4. Проверка
- Открой `https://<проект>.vercel.app/api/webhook` → `Tang Jee Rina Webhook API Operational`.
- Напиши боту в Telegram.
- Крон: Vercel → Project → Settings → Cron Jobs → Run. На бесплатном Hobby крон может запускаться не чаще 1 раза в сутки (сейчас 12:00 UTC, меняется в vercel.json).

## Если модель не отвечает
Имена моделей у Google меняются. Открой логи Vercel (Logs) — там будет `Gemini ... HTTP 404`.
Актуальный список: https://ai.google.dev/gemini-api/docs/models. Впиши имя в `GEMINI_MODEL`.
