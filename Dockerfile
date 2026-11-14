FROM node:20-alpine
ENV NODE_ENV=production
ENV HOST=0.0.0.0
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.html app.js styles.css server.js schema.sql ./
EXPOSE 3000
CMD ["npm", "start"]
