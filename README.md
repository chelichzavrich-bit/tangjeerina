# Танг Джи Рина - Telegram-бот (Vercel + Gemini, бесплатно)

## Структура
```
api/webhook.js    - приём сообщений Telegram (POST), проверка "жив ли" (GET)
api/pulse.js      - "пульс": бот пишет первым
lib/persona.js    - SYSTEM_INSTRUCTION и технические приписки (текст персонажа здесь, кодом не правится)
lib/ai.js         - Gemini: цепочка моделей, ретраи при фильтре, лимит токенов
lib/files.js      - чтение фото / PDF / DOCX / TXT / голосовых / видео
lib/memory.js     - история чатов (Upstash Redis или память процесса)
lib/pulse.js      - расписание проактивных сообщений
lib/telegram.js   - отправка, нарезка длинных ответов, скачивание файлов
lib/fallbacks.js  - запасные "злые" отговорки
.github/workflows/pulse.yml - бесплатный будильник для пульса
```

## 1. Переменные окружения (Vercel → Settings → Environment Variables → Production)
Обязательные: `TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`, `CRON_SECRET` (случайная строка 16+ символов).
Остальное - см. `.env.example` (все значения по умолчанию рабочие).

## 2. Память (нужна для «живого» режима)
Vercel → Storage / Marketplace → **Upstash Redis** → бесплатный план → Connect to Project.
Vercel сам добавит переменные `KV_REST_API_URL` и `KV_REST_API_TOKEN` (или `UPSTASH_REDIS_REST_*`). После этого **Redeploy**.
Без Redis бот отвечает, но память сбрасывается, когда функция "засыпает", а пульс по расписанию не работает.

## 3. Вебхук (один раз)
```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<проект>.vercel.app/api/webhook
```
(если задан `TELEGRAM_WEBHOOK_SECRET`, добавьте `&secret_token=<то же значение>`).
Используйте production-домен, не preview.

## 4. Пульс (бот пишет первым)
Бесплатный Vercel-крон (Hobby) запускается максимум раз в сутки, поэтому случайные интервалы 30 мин - 4 ч делаются так:
внешний "будильник" дёргает `/api/pulse` каждые ~20 минут, а бот сам решает, пора ли писать (у каждого чата своя случайная пауза,
в тихие часы молчит, после 2 сообщений без ответа затихает).

Вариант А - GitHub Actions (файл уже в архиве): репозиторий → Settings → Secrets and variables → Actions →
добавить `PULSE_URL` = `https://<проект>.vercel.app/api/pulse` и `CRON_SECRET` = то же значение, что в Vercel.
Вариант Б - cron-job.org: URL `.../api/pulse`, каждые 20 минут, заголовок `Authorization: Bearer <CRON_SECRET>`.

Проверка вручную (сразу отправит сообщение в чат): 
```
curl -H "Authorization: Bearer <CRON_SECRET>" "https://<проект>.vercel.app/api/pulse?force=1&chat_id=<ID>"
```
