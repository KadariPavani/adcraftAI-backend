# Use official Node.js LTS image
FROM node:18-slim

WORKDIR /app

# Install supabase CLI globally
RUN npm install -g supabase

# Copy supabase functions and migrations
COPY supabase/. .

# Expose port 8029
EXPOSE 8029

CMD ["supabase", "functions", "serve", "--no-verify-jwt"]
