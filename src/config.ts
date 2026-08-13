import dotenv from 'dotenv';
import path from 'node:path';

// Load local variables when running from source. Cloud Run supplies variables
// through its environment, so this is intentionally a no-op there.
dotenv.config({
  path: process.env.DOTENV_CONFIG_PATH ?? path.resolve(process.cwd(), '.env'),
});

export const config = {
  gcp: {
    get projectId() {
      return process.env.GCP_PROJECT_ID ?? 'geminixprize-504607';
    },
    get location() {
      return process.env.GCP_LOCATION ?? 'us-central1';
    },
  },
  gemini: {
    get apiKey() {
      return process.env.GEMINI_API_KEY ?? '';
    },
    get model() {
      return process.env.GEMINI_MODEL ?? 'gemini-flash-latest';
    },
  },
  resend: {
    get apiKey() {
      return process.env.RESEND_API_KEY ?? '';
    },
    get fromEmail() {
      return process.env.RESEND_FROM_EMAIL ?? 'alerts@stratemark.io';
    },
  },
  stripe: {
    get secretKey() {
      return process.env.STRIPE_SECRET_KEY ?? '';
    },
    get webhookSecret() {
      return process.env.STRIPE_WEBHOOK_SECRET ?? '';
    },
  },
  app: {
    get url() {
      return process.env.APP_URL ?? 'https://stratemark.io';
    },
  },
  scrape: {
    get intervalHours() {
      return parseInt(process.env.SCRAPE_INTERVAL_HOURS ?? '6', 10);
    },
  },
};
