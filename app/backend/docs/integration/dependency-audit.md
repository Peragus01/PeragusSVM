# Auditoria das dependências do backend — 2026-10-26

Correção compatível com a integração atual: Fastify 5.12.7, Zod 4.6.7 no lockfile (mínimo declarado 4.6.6), fast-uri 4.2.3 e a cópia transitiva 3.1.9 do Ajv. Removido @coral-xyz/anchor: não havia importações no src, testes ou scripts deste backend. Isso também remove toml e dependências exclusivas do Anchor. Não altera o programa on-chain ou os outros projetos do monorepo.

Referências oficiais:

- https://github.com/advisories/GHSA-389g-gv7q-r4x8
- https://github.com/advisories/GHSA-mrhx-c7xc-m3w5
- https://github.com/advisories/GHSA-w74x-v6f9-j3xg
- https://github.com/advisories/GHSA-v5mp-jgw5-2x6j

## Pendências explícitas

`npm audit --omit=dev` após instalação limpa: quatro pacotes moderados, zero altos/críticos. Os quatro pacotes são @solana/web3.js, jayson, stream-json e uuid; a contagem inclui propagação transitiva, não quatro caminhos independentes demonstrados de exploração. O comando continua retornando código 1; nenhum alerta foi suprimido. O resultado depende da base de advisories e deve ser repetido ao atualizar.

O resolvedor sugere @solana/web3.js 3.1.1 como mudança SemVer major. Não foi forçada nesta correção. A remoção integral da biblioteca também exige mudanças: PublicKey é usado no vínculo/prova de carteira e na validação de retirada, além dos provedores Solana antigos.

Inspeção da versão instalada: web3.js/lib/index.cjs.js carrega jayson/lib/client/browser; este e generateRequest usam uuid.v4. A montagem de respostas usa JSON.parse, sem importar jayson/lib/utils.js, que contém o parser stream-json. Não há importações diretas de stream-json, toml, jayson ou uuid no src/scripts do backend. Isso limita a exposição observada, mas não comprova ausência de risco em todos os caminhos, inclusive dependências carregadas indiretamente.

Referências remanescentes:

- https://github.com/advisories/GHSA-mjw6-4jj6-33hc
- https://github.com/advisories/GHSA-528h-pc64-c93x
- https://github.com/advisories/GHSA-hqr4-qq8f-hg3x
- https://github.com/advisories/GHSA-w5hq-g745-h8pq

Não considerar flags financeiras desligadas como correção de dependências. Manter o piloto em sandbox e rastrear a migração do cliente Solana antes de declarar as dependências livres de alertas. Sem overrides de versões principais nem audit fix --force.

Validação: npm ci --ignore-scripts --no-audit --no-fund, npm run build, suíte completa do backend e auditoria de produção. Sem migration, mudança de rotas, frontend ou flags.
