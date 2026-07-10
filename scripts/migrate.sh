#!/bin/bash

echo "🔄 Running database migrations..."

# Run Prisma migrations
npm run prisma:migrate

echo "✅ Migrations complete!"
