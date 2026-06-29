# Use official Node.js LTS image
FROM node:18-slim

# Set working directory
WORKDIR /app

# Install supabase CLI globally
RUN npm install -g supabase

# Copy package manifests from supabase folder first for caching
COPY supabase/package*.json ./ 

# Install dependencies
RUN npm install --production

# Copy the rest of the application code from supabase folder
COPY supabase/. .

# Expose port 8029
EXPOSE 8029

# Default command: run supabase functions locally
CMD ["supabase", "functions", "serve", "--no-verify-jwt"]
