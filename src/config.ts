export const config = {
  gcp: {
    projectId: process.env.GCP_PROJECT_ID ?? 'geminixprize-504607',
    location: process.env.GCP_LOCATION ?? 'us-central1',
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? '',
    model: process.env.GEMINI_MODEL ?? 'gemini-flash-latest',
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY ?? '',
    fromEmail: process.env.RESEND_FROM_EMAIL ?? 'alerts@stratemark.io',
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  },
  app: {
    url: process.env.APP_URL ?? 'https://stratemark.io',
  },
  scrape: {
    intervalHours: parseInt(process.env.SCRAPE_INTERVAL_HOURS ?? '6', 10),
  },
} as const;
