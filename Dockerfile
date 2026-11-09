FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs client.js ./
COPY index.html.gz ./
USER node
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.mjs"]
