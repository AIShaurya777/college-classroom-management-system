FROM node:20-alpine

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json package-lock.json ./

RUN npm ci --production

# Copy application code
COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
