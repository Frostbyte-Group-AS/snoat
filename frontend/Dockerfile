FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

# Vite baker VITE_-variabler inn i bundlen ved build, ikke ved oppstart. De må
# derfor komme inn som build-args – å sette dem som `environment` i compose gir
# en bundle som fortsatt peker på det domenet builden tilfeldigvis så.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_SNOAT_API_URL
ARG VITE_SNOAT_APP_DOMAIN_SUFFIX
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY
ENV VITE_SNOAT_API_URL=$VITE_SNOAT_API_URL
ENV VITE_SNOAT_APP_DOMAIN_SUFFIX=$VITE_SNOAT_APP_DOMAIN_SUFFIX

# Fanger feil konfigurasjon i build-steget i stedet for i nettleseren til
# brukeren. Uten dette blir resultatet kall mot feil domene først etter deploy.
RUN test -n "$VITE_SUPABASE_URL" -a -n "$VITE_SUPABASE_ANON_KEY" \
  || (echo "VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY mangler – kjør scripts/bootstrap-env.mjs" >&2; exit 1)

RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

COPY --from=builder /app/.output ./.output
COPY --from=builder /app/package.json ./

# TanStack Start with Nitro by default outputs to .output/server/index.mjs
CMD ["node", ".output/server/index.mjs"]
