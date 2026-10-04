FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY config.example.json ./
EXPOSE 11452
CMD ["node", "src/server.js"]
