# Build Stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies including devDependencies for build
RUN npm install

# Copy source code
COPY . .

# Build the project
RUN npm run build

# Production Stage
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm install --omit=dev

# Copy built files from builder stage
COPY --from=builder /app/dist ./dist

# Expose the API port
EXPOSE 4000

# Run any pending DB migrations before starting the API. TypeORM records applied
# migrations, so this is idempotent and safe to run on every container start. It
# prevents "column does not exist" 5xx errors when code is deployed ahead of its
# schema (e.g. the driver status endpoint failing after the NIN columns were
# added but the migration hadn't been run).
CMD ["sh", "-c", "npm run migration:run && node dist/index.js"]
