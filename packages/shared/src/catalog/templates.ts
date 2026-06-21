import { z } from "zod";

export const catalogCategorySchema = z.enum([
  "web",
  "monitoring",
  "database",
  "devtools",
  "automation",
  "utility"
]);

export const catalogTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  category: catalogCategorySchema,
  composeYaml: z.string().min(1),
  defaultEnv: z.record(z.string()).default({}),
  suggestedVolumes: z.array(z.string()).default([]),
  suggestedPorts: z.array(z.string()).default([]),
  docsUrl: z.string().url()
});

export type CatalogTemplate = z.infer<typeof catalogTemplateSchema>;

export const customCatalogTemplateInputSchema = z.object({
  id: z.string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "Use lowercase letters, numbers, hyphens, or underscores, and start with a letter or number"),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500),
  category: catalogCategorySchema,
  composeYaml: z.string().trim().min(1),
  defaultEnv: z.record(z.string()).default({}),
  suggestedVolumes: z.array(z.string().trim().min(1).max(160)).default([]),
  suggestedPorts: z.array(z.string().trim().min(1).max(80)).default([]),
  docsUrl: z.string().trim().url().nullable().optional()
});

export type CustomCatalogTemplateInput = z.infer<typeof customCatalogTemplateInputSchema>;

export const externalCatalogSourceSchema = z.enum(["awesome-selfhosted"]);

export const externalCatalogQuerySchema = z.object({
  source: externalCatalogSourceSchema.default("awesome-selfhosted"),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  query: z.string().trim().max(120).optional(),
  includeArchived: z.preprocess((value) => value === true || value === "true", z.boolean()).default(false)
});

export type ExternalCatalogQuery = z.infer<typeof externalCatalogQuerySchema>;

export const externalCatalogCandidateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: catalogCategorySchema,
  source: externalCatalogSourceSchema,
  sourceLabel: z.string(),
  websiteUrl: z.string().url().nullable(),
  docsUrl: z.string().url(),
  sourceCodeUrl: z.string().url().nullable(),
  demoUrl: z.string().url().nullable(),
  licenses: z.array(z.string()),
  platforms: z.array(z.string()),
  tags: z.array(z.string()),
  stargazersCount: z.number().int().nonnegative().nullable(),
  updatedAt: z.string().nullable(),
  latestRelease: z.object({
    tag: z.string().nullable(),
    publishedAt: z.string().nullable()
  }).nullable(),
  archived: z.boolean(),
  importTemplate: customCatalogTemplateInputSchema
});

export type ExternalCatalogCandidate = z.infer<typeof externalCatalogCandidateSchema>;

export const externalCatalogResponseSchema = z.object({
  source: externalCatalogSourceSchema,
  sourceLabel: z.string(),
  sourceUrl: z.string().url(),
  fetchedAt: z.string(),
  total: z.number().int().nonnegative(),
  candidates: z.array(externalCatalogCandidateSchema)
});

export type ExternalCatalogResponse = z.infer<typeof externalCatalogResponseSchema>;

export const catalogTemplates: CatalogTemplate[] = [
  {
    id: "nginx",
    name: "Nginx",
    description: "Lightweight reverse proxy and static file server.",
    category: "web",
    composeYaml: `services:
  nginx:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "\${NGINX_PORT:-8080}:80"
    volumes:
      - nginx_html:/usr/share/nginx/html
volumes:
  nginx_html:
`,
    defaultEnv: { NGINX_PORT: "8080" },
    suggestedVolumes: ["nginx_html"],
    suggestedPorts: ["8080:80"],
    docsUrl: "https://nginx.org/en/docs/"
  },
  {
    id: "uptime-kuma",
    name: "Uptime Kuma",
    description: "Self-hosted uptime monitoring with status pages.",
    category: "monitoring",
    composeYaml: `services:
  uptime-kuma:
    image: louislam/uptime-kuma:1
    restart: unless-stopped
    ports:
      - "\${UPTIME_PORT:-3001}:3001"
    volumes:
      - uptime_data:/app/data
volumes:
  uptime_data:
`,
    defaultEnv: { UPTIME_PORT: "3001" },
    suggestedVolumes: ["uptime_data"],
    suggestedPorts: ["3001:3001"],
    docsUrl: "https://github.com/louislam/uptime-kuma"
  },
  {
    id: "postgres",
    name: "Postgres",
    description: "Relational database for apps and services.",
    category: "database",
    composeYaml: `services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: \${POSTGRES_DB:-app}
      POSTGRES_USER: \${POSTGRES_USER:-app}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
    ports:
      - "\${POSTGRES_PORT:-5432}:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
volumes:
  postgres_data:
`,
    defaultEnv: { POSTGRES_DB: "app", POSTGRES_USER: "app", POSTGRES_PASSWORD: "change-me", POSTGRES_PORT: "5432" },
    suggestedVolumes: ["postgres_data"],
    suggestedPorts: ["5432:5432"],
    docsUrl: "https://www.postgresql.org/docs/"
  },
  {
    id: "redis",
    name: "Redis",
    description: "In-memory cache, queue, and session store.",
    category: "database",
    composeYaml: `services:
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    ports:
      - "\${REDIS_PORT:-6379}:6379"
    volumes:
      - redis_data:/data
volumes:
  redis_data:
`,
    defaultEnv: { REDIS_PORT: "6379" },
    suggestedVolumes: ["redis_data"],
    suggestedPorts: ["6379:6379"],
    docsUrl: "https://redis.io/docs/"
  },
  {
    id: "bookstack",
    name: "BookStack",
    description: "Wiki and documentation platform.",
    category: "devtools",
    composeYaml: `services:
  bookstack:
    image: lscr.io/linuxserver/bookstack:latest
    restart: unless-stopped
    environment:
      PUID: "1000"
      PGID: "1000"
      APP_URL: \${BOOKSTACK_URL:-http://localhost:6875}
      DB_HOST: bookstack_db
      DB_DATABASE: \${BOOKSTACK_DB:-bookstack}
      DB_USERNAME: \${BOOKSTACK_DB_USER:-bookstack}
      DB_PASSWORD: \${BOOKSTACK_DB_PASSWORD}
    ports:
      - "\${BOOKSTACK_PORT:-6875}:80"
    depends_on:
      - bookstack_db
    volumes:
      - bookstack_data:/config
  bookstack_db:
    image: mariadb:11
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: \${BOOKSTACK_DB_ROOT_PASSWORD}
      MYSQL_DATABASE: \${BOOKSTACK_DB:-bookstack}
      MYSQL_USER: \${BOOKSTACK_DB_USER:-bookstack}
      MYSQL_PASSWORD: \${BOOKSTACK_DB_PASSWORD}
    volumes:
      - bookstack_db:/var/lib/mysql
volumes:
  bookstack_data:
  bookstack_db:
`,
    defaultEnv: {
      BOOKSTACK_PORT: "6875",
      BOOKSTACK_URL: "http://localhost:6875",
      BOOKSTACK_DB: "bookstack",
      BOOKSTACK_DB_USER: "bookstack",
      BOOKSTACK_DB_PASSWORD: "change-me",
      BOOKSTACK_DB_ROOT_PASSWORD: "change-me-root"
    },
    suggestedVolumes: ["bookstack_data", "bookstack_db"],
    suggestedPorts: ["6875:80"],
    docsUrl: "https://www.bookstackapp.com/docs/"
  },
  {
    id: "gitea",
    name: "Gitea",
    description: "Self-hosted Git forge with issues and CI hooks.",
    category: "devtools",
    composeYaml: `services:
  gitea:
    image: gitea/gitea:1.22-rootless
    restart: unless-stopped
    environment:
      GITEA__server__ROOT_URL: \${GITEA_URL:-http://localhost:3000}
    ports:
      - "\${GITEA_HTTP_PORT:-3000}:3000"
      - "\${GITEA_SSH_PORT:-2222}:2222"
    volumes:
      - gitea_data:/var/lib/gitea
volumes:
  gitea_data:
`,
    defaultEnv: { GITEA_URL: "http://localhost:3000", GITEA_HTTP_PORT: "3000", GITEA_SSH_PORT: "2222" },
    suggestedVolumes: ["gitea_data"],
    suggestedPorts: ["3000:3000", "2222:2222"],
    docsUrl: "https://docs.gitea.com/"
  },
  {
    id: "n8n",
    name: "n8n",
    description: "Workflow automation with webhooks and integrations.",
    category: "automation",
    composeYaml: `services:
  n8n:
    image: n8nio/n8n:latest
    restart: unless-stopped
    environment:
      N8N_HOST: \${N8N_HOST:-localhost}
      N8N_PORT: "5678"
      N8N_PROTOCOL: \${N8N_PROTOCOL:-http}
      WEBHOOK_URL: \${N8N_WEBHOOK_URL:-http://localhost:5678/}
    ports:
      - "\${N8N_PORT:-5678}:5678"
    volumes:
      - n8n_data:/home/node/.n8n
volumes:
  n8n_data:
`,
    defaultEnv: {
      N8N_HOST: "localhost",
      N8N_PROTOCOL: "http",
      N8N_PORT: "5678",
      N8N_WEBHOOK_URL: "http://localhost:5678/"
    },
    suggestedVolumes: ["n8n_data"],
    suggestedPorts: ["5678:5678"],
    docsUrl: "https://docs.n8n.io/"
  },
  {
    id: "whoami",
    name: "Whoami",
    description: "Tiny HTTP service for proxy and routing smoke tests.",
    category: "utility",
    composeYaml: `services:
  whoami:
    image: traefik/whoami:latest
    restart: unless-stopped
    ports:
      - "\${WHOAMI_PORT:-8088}:80"
`,
    defaultEnv: { WHOAMI_PORT: "8088" },
    suggestedVolumes: [],
    suggestedPorts: ["8088:80"],
    docsUrl: "https://github.com/traefik/whoami"
  },
  {
    id: "adminer",
    name: "Adminer",
    description: "Web UI for managing SQL databases.",
    category: "database",
    composeYaml: `services:
  adminer:
    image: adminer:4
    restart: unless-stopped
    ports:
      - "\${ADMINER_PORT:-8081}:8080"
`,
    defaultEnv: { ADMINER_PORT: "8081" },
    suggestedVolumes: [],
    suggestedPorts: ["8081:8080"],
    docsUrl: "https://www.adminer.org/"
  },
  {
    id: "portainer-agent",
    name: "Portainer Agent",
    description: "Remote Docker environment agent (for multi-node setups).",
    category: "utility",
    composeYaml: `services:
  portainer_agent:
    image: portainer/agent:2.21.4
    restart: unless-stopped
    ports:
      - "\${AGENT_PORT:-9001}:9001"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /var/lib/docker/volumes:/var/lib/docker/volumes
`,
    defaultEnv: { AGENT_PORT: "9001" },
    suggestedVolumes: [],
    suggestedPorts: ["9001:9001"],
    docsUrl: "https://docs.portainer.io/agent"
  },
  {
    id: "nextcloud",
    name: "Nextcloud",
    description: "File sync, sharing, calendar, contacts, and collaboration server.",
    category: "web",
    composeYaml: `services:
  nextcloud:
    image: nextcloud:apache
    restart: unless-stopped
    environment:
      MYSQL_HOST: nextcloud_db
      MYSQL_DATABASE: \${NEXTCLOUD_DB:-nextcloud}
      MYSQL_USER: \${NEXTCLOUD_DB_USER:-nextcloud}
      MYSQL_PASSWORD: \${NEXTCLOUD_DB_PASSWORD}
    ports:
      - "\${NEXTCLOUD_PORT:-8082}:80"
    volumes:
      - nextcloud_data:/var/www/html
    depends_on:
      - nextcloud_db
  nextcloud_db:
    image: mariadb:11
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: \${NEXTCLOUD_DB_ROOT_PASSWORD}
      MYSQL_DATABASE: \${NEXTCLOUD_DB:-nextcloud}
      MYSQL_USER: \${NEXTCLOUD_DB_USER:-nextcloud}
      MYSQL_PASSWORD: \${NEXTCLOUD_DB_PASSWORD}
    volumes:
      - nextcloud_db:/var/lib/mysql
volumes:
  nextcloud_data:
  nextcloud_db:
`,
    defaultEnv: {
      NEXTCLOUD_PORT: "8082",
      NEXTCLOUD_DB: "nextcloud",
      NEXTCLOUD_DB_USER: "nextcloud",
      NEXTCLOUD_DB_PASSWORD: "change-me",
      NEXTCLOUD_DB_ROOT_PASSWORD: "change-me-root"
    },
    suggestedVolumes: ["nextcloud_data", "nextcloud_db"],
    suggestedPorts: ["8082:80"],
    docsUrl: "https://docs.nextcloud.com/server/latest/admin_manual/"
  },
  {
    id: "jellyfin",
    name: "Jellyfin",
    description: "Personal media server for movies, shows, music, and live TV.",
    category: "utility",
    composeYaml: `services:
  jellyfin:
    image: jellyfin/jellyfin:latest
    restart: unless-stopped
    ports:
      - "\${JELLYFIN_PORT:-8096}:8096"
    volumes:
      - jellyfin_config:/config
      - jellyfin_cache:/cache
      - \${JELLYFIN_MEDIA_PATH:-/srv/media}:/media:ro
volumes:
  jellyfin_config:
  jellyfin_cache:
`,
    defaultEnv: { JELLYFIN_PORT: "8096", JELLYFIN_MEDIA_PATH: "/srv/media" },
    suggestedVolumes: ["jellyfin_config", "jellyfin_cache"],
    suggestedPorts: ["8096:8096"],
    docsUrl: "https://jellyfin.org/docs/"
  },
  {
    id: "home-assistant",
    name: "Home Assistant",
    description: "Local-first home automation platform.",
    category: "automation",
    composeYaml: `services:
  home-assistant:
    image: ghcr.io/home-assistant/home-assistant:stable
    restart: unless-stopped
    privileged: true
    network_mode: host
    volumes:
      - homeassistant_config:/config
      - /etc/localtime:/etc/localtime:ro
volumes:
  homeassistant_config:
`,
    defaultEnv: {},
    suggestedVolumes: ["homeassistant_config"],
    suggestedPorts: ["8123"],
    docsUrl: "https://www.home-assistant.io/docs/"
  },
  {
    id: "vaultwarden",
    name: "Vaultwarden",
    description: "Lightweight Bitwarden-compatible password manager.",
    category: "utility",
    composeYaml: `services:
  vaultwarden:
    image: vaultwarden/server:latest
    restart: unless-stopped
    environment:
      DOMAIN: \${VAULTWARDEN_DOMAIN:-http://localhost:8083}
      SIGNUPS_ALLOWED: "\${VAULTWARDEN_SIGNUPS:-false}"
    ports:
      - "\${VAULTWARDEN_PORT:-8083}:80"
    volumes:
      - vaultwarden_data:/data
volumes:
  vaultwarden_data:
`,
    defaultEnv: { VAULTWARDEN_PORT: "8083", VAULTWARDEN_DOMAIN: "http://localhost:8083", VAULTWARDEN_SIGNUPS: "false" },
    suggestedVolumes: ["vaultwarden_data"],
    suggestedPorts: ["8083:80"],
    docsUrl: "https://github.com/dani-garcia/vaultwarden/wiki"
  },
  {
    id: "grafana",
    name: "Grafana",
    description: "Dashboards and visualization for metrics and logs.",
    category: "monitoring",
    composeYaml: `services:
  grafana:
    image: grafana/grafana-oss:latest
    restart: unless-stopped
    ports:
      - "\${GRAFANA_PORT:-3002}:3000"
    volumes:
      - grafana_data:/var/lib/grafana
volumes:
  grafana_data:
`,
    defaultEnv: { GRAFANA_PORT: "3002" },
    suggestedVolumes: ["grafana_data"],
    suggestedPorts: ["3002:3000"],
    docsUrl: "https://grafana.com/docs/grafana/latest/"
  },
  {
    id: "prometheus",
    name: "Prometheus",
    description: "Metrics collection and time-series monitoring.",
    category: "monitoring",
    composeYaml: `services:
  prometheus:
    image: prom/prometheus:latest
    restart: unless-stopped
    ports:
      - "\${PROMETHEUS_PORT:-9090}:9090"
    volumes:
      - prometheus_data:/prometheus
volumes:
  prometheus_data:
`,
    defaultEnv: { PROMETHEUS_PORT: "9090" },
    suggestedVolumes: ["prometheus_data"],
    suggestedPorts: ["9090:9090"],
    docsUrl: "https://prometheus.io/docs/introduction/overview/"
  },
  {
    id: "node-red",
    name: "Node-RED",
    description: "Flow-based automation and integration builder.",
    category: "automation",
    composeYaml: `services:
  node-red:
    image: nodered/node-red:latest
    restart: unless-stopped
    ports:
      - "\${NODE_RED_PORT:-1880}:1880"
    volumes:
      - node_red_data:/data
volumes:
  node_red_data:
`,
    defaultEnv: { NODE_RED_PORT: "1880" },
    suggestedVolumes: ["node_red_data"],
    suggestedPorts: ["1880:1880"],
    docsUrl: "https://nodered.org/docs/"
  },
  {
    id: "minio",
    name: "MinIO",
    description: "S3-compatible object storage for self-hosted infrastructure.",
    category: "utility",
    composeYaml: `services:
  minio:
    image: minio/minio:latest
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: \${MINIO_ROOT_USER:-minioadmin}
      MINIO_ROOT_PASSWORD: \${MINIO_ROOT_PASSWORD}
    ports:
      - "\${MINIO_API_PORT:-9000}:9000"
      - "\${MINIO_CONSOLE_PORT:-9001}:9001"
    volumes:
      - minio_data:/data
volumes:
  minio_data:
`,
    defaultEnv: { MINIO_ROOT_USER: "minioadmin", MINIO_ROOT_PASSWORD: "change-me-minio", MINIO_API_PORT: "9000", MINIO_CONSOLE_PORT: "9001" },
    suggestedVolumes: ["minio_data"],
    suggestedPorts: ["9000:9000", "9001:9001"],
    docsUrl: "https://min.io/docs/minio/container/index.html"
  },
  {
    id: "mariadb",
    name: "MariaDB",
    description: "MySQL-compatible relational database server.",
    category: "database",
    composeYaml: `services:
  mariadb:
    image: mariadb:11
    restart: unless-stopped
    environment:
      MARIADB_ROOT_PASSWORD: \${MARIADB_ROOT_PASSWORD}
      MARIADB_DATABASE: \${MARIADB_DATABASE:-app}
      MARIADB_USER: \${MARIADB_USER:-app}
      MARIADB_PASSWORD: \${MARIADB_PASSWORD}
    ports:
      - "\${MARIADB_PORT:-3306}:3306"
    volumes:
      - mariadb_data:/var/lib/mysql
volumes:
  mariadb_data:
`,
    defaultEnv: { MARIADB_ROOT_PASSWORD: "change-me-root", MARIADB_DATABASE: "app", MARIADB_USER: "app", MARIADB_PASSWORD: "change-me", MARIADB_PORT: "3306" },
    suggestedVolumes: ["mariadb_data"],
    suggestedPorts: ["3306:3306"],
    docsUrl: "https://mariadb.com/kb/en/documentation/"
  },
  {
    id: "mongodb",
    name: "MongoDB",
    description: "Document database for application data.",
    category: "database",
    composeYaml: `services:
  mongodb:
    image: mongo:7
    restart: unless-stopped
    environment:
      MONGO_INITDB_ROOT_USERNAME: \${MONGO_ROOT_USER:-mongo}
      MONGO_INITDB_ROOT_PASSWORD: \${MONGO_ROOT_PASSWORD}
    ports:
      - "\${MONGO_PORT:-27017}:27017"
    volumes:
      - mongodb_data:/data/db
volumes:
  mongodb_data:
`,
    defaultEnv: { MONGO_ROOT_USER: "mongo", MONGO_ROOT_PASSWORD: "change-me", MONGO_PORT: "27017" },
    suggestedVolumes: ["mongodb_data"],
    suggestedPorts: ["27017:27017"],
    docsUrl: "https://www.mongodb.com/docs/manual/"
  },
  {
    id: "caddy",
    name: "Caddy",
    description: "Automatic HTTPS reverse proxy and web server.",
    category: "web",
    composeYaml: `services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "\${CADDY_HTTP_PORT:-80}:80"
      - "\${CADDY_HTTPS_PORT:-443}:443"
    volumes:
      - caddy_data:/data
      - caddy_config:/config
volumes:
  caddy_data:
  caddy_config:
`,
    defaultEnv: { CADDY_HTTP_PORT: "80", CADDY_HTTPS_PORT: "443" },
    suggestedVolumes: ["caddy_data", "caddy_config"],
    suggestedPorts: ["80:80", "443:443"],
    docsUrl: "https://caddyserver.com/docs/"
  },
  {
    id: "traefik",
    name: "Traefik",
    description: "Docker-aware edge router and reverse proxy.",
    category: "web",
    composeYaml: `services:
  traefik:
    image: traefik:v3.1
    restart: unless-stopped
    command:
      - --api.dashboard=true
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --entrypoints.web.address=:80
    ports:
      - "\${TRAEFIK_HTTP_PORT:-80}:80"
      - "\${TRAEFIK_DASHBOARD_PORT:-8080}:8080"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
`,
    defaultEnv: { TRAEFIK_HTTP_PORT: "80", TRAEFIK_DASHBOARD_PORT: "8080" },
    suggestedVolumes: [],
    suggestedPorts: ["80:80", "8080:8080"],
    docsUrl: "https://doc.traefik.io/traefik/"
  },
  {
    id: "pihole",
    name: "Pi-hole",
    description: "Network-wide DNS sinkhole and ad blocker.",
    category: "utility",
    composeYaml: `services:
  pihole:
    image: pihole/pihole:latest
    restart: unless-stopped
    environment:
      TZ: \${PIHOLE_TZ:-UTC}
      WEBPASSWORD: \${PIHOLE_PASSWORD}
    ports:
      - "\${PIHOLE_DNS_PORT:-53}:53/tcp"
      - "\${PIHOLE_DNS_PORT:-53}:53/udp"
      - "\${PIHOLE_WEB_PORT:-8084}:80"
    volumes:
      - pihole_config:/etc/pihole
      - pihole_dnsmasq:/etc/dnsmasq.d
volumes:
  pihole_config:
  pihole_dnsmasq:
`,
    defaultEnv: { PIHOLE_TZ: "UTC", PIHOLE_PASSWORD: "change-me", PIHOLE_DNS_PORT: "53", PIHOLE_WEB_PORT: "8084" },
    suggestedVolumes: ["pihole_config", "pihole_dnsmasq"],
    suggestedPorts: ["53:53/tcp", "53:53/udp", "8084:80"],
    docsUrl: "https://docs.pi-hole.net/"
  },
  {
    id: "adguard-home",
    name: "AdGuard Home",
    description: "Network-wide DNS filtering and parental controls.",
    category: "utility",
    composeYaml: `services:
  adguard-home:
    image: adguard/adguardhome:latest
    restart: unless-stopped
    ports:
      - "\${ADGUARD_DNS_PORT:-5353}:53/tcp"
      - "\${ADGUARD_DNS_PORT:-5353}:53/udp"
      - "\${ADGUARD_SETUP_PORT:-3003}:3000"
      - "\${ADGUARD_WEB_PORT:-8085}:80"
    volumes:
      - adguard_work:/opt/adguardhome/work
      - adguard_conf:/opt/adguardhome/conf
volumes:
  adguard_work:
  adguard_conf:
`,
    defaultEnv: { ADGUARD_DNS_PORT: "5353", ADGUARD_SETUP_PORT: "3003", ADGUARD_WEB_PORT: "8085" },
    suggestedVolumes: ["adguard_work", "adguard_conf"],
    suggestedPorts: ["5353:53/tcp", "5353:53/udp", "3003:3000", "8085:80"],
    docsUrl: "https://github.com/AdguardTeam/AdGuardHome/wiki"
  }
];

export function getCatalogTemplate(id: string) {
  return catalogTemplates.find((template) => template.id === id) ?? null;
}
