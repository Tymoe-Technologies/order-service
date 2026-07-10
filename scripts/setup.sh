#!/bin/bash

echo "🚀 Setting up Order Service..."

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Generate Prisma client
echo "🔧 Generating Prisma client..."
npm run prisma:generate

# Create logs directory if not exists
mkdir -p logs

echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Configure your .env file"
echo "2. Run 'npm run prisma:migrate' to create database tables"
echo "3. Run 'npm run dev' to start the development server"
