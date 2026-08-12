#!/bin/bash
set -e

echo "=== STRATEMARK Sentinel — GCP Setup ==="
echo ""

PROJECT_ID="${GCP_PROJECT_ID:-geminixprize-504607}"
REGION="${GCP_REGION:-us-central1}"

echo "Project: $PROJECT_ID"
echo "Region: $REGION"
echo ""

# Enable APIs
echo "Enabling GCP APIs..."
gcloud services enable run.googleapis.com \
  firestore.googleapis.com \
  cloudfunctions.googleapis.com \
  cloudscheduler.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  storage.googleapis.com \
  --project=$PROJECT_ID

# Deploy Cloud Run from monorepo root
echo "Deploying Cloud Run service..."
gcloud run deploy sentinel \
  --source . \
  --region $REGION \
  --allow-unauthenticated \
  --project=$PROJECT_ID \
  --set-env-vars GCP_PROJECT_ID=$PROJECT_ID

# Grab the actual URL and update APP_URL
SERVICE_URL=$(gcloud run services describe sentinel --region=$REGION --project=$PROJECT_ID --format='value(status.url)')
echo "Service deployed at: $SERVICE_URL"

gcloud run services update sentinel --region=$REGION --project=$PROJECT_ID \
  --set-env-vars GCP_PROJECT_ID=$PROJECT_ID,APP_URL=$SERVICE_URL

echo ""
echo "=== Done ==="
