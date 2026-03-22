FROM --platform=linux/arm64 mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

# Cài Chromium cho Playwright
RUN npx playwright install chromium

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
