FROM cgr.dev/chainguard/node:latest-dev AS dependencies
USER root
WORKDIR /app
COPY package.json package-lock.json ./
RUN ["npm", "ci", "--omit=dev", "--ignore-scripts", "--cache=/tmp/npm-cache"]
COPY src ./src

FROM dependencies AS verify
COPY test ./test
COPY manifest.json .env.cloud.example ./
COPY terraform/main.tf terraform/terraform.tfvars.example ./terraform/
USER 65532:65532
RUN ["npm", "test"]

FROM cgr.dev/chainguard/node:latest
ENV NODE_ENV=production
WORKDIR /app
COPY --from=verify --chown=65532:65532 /app/package.json ./package.json
COPY --from=verify --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=verify --chown=65532:65532 /app/src ./src
USER 65532:65532
EXPOSE 8080
CMD ["src/cloud-app.js"]
