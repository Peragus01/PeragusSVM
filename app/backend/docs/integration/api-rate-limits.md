# Limites da API autenticada

Aplicar migration 032 antes de habilitar API_RATE_LIMITS_ENABLED=true somente no serviço API. Padrão false para implantação controlada. Worker não utiliza esta flag. Sem dependência npm adicional ou frontend alterado.

Por UUID de usuário autenticado pelo Supabase: 60 GET/HEAD por minuto e 10 outros métodos por minuto. Cada classe compartilha uma janela de um minuto iniciada na primeira requisição. SQL UPSERT atômico e relógio do Postgres mantêm cota entre instâncias e reinícios. Uma janela fixa pode permitir dois blocos próximos à virada; não é limite móvel nem controle de concorrência.

A contagem ocorre após validar o bearer e antes de consultar perfil, validar permissões de cliente/operador e executar handlers /v1. Inclui operador, conta sem perfil, erros de autorização e repetições idempotentes; preserva os limites adicionais dos convites. Trocar token, IP, headers, URL ou request_id não troca a identidade validada nem a cota. GET e HEAD compartilham a cota de leitura.

Respostas passam RateLimit-Limit/RateLimit-Remaining. Esgotamento retorna 429 API_RATE_LIMIT_EXCEEDED, Retry-After inteiro em segundos e Cache-Control:no-store. Cliente deve respeitar Retry-After, não gerar nova chave idempotente nem repetir automaticamente operações financeiras. Indisponibilidade do contador retorna 503 API_RATE_LIMIT_UNAVAILABLE antes do handler; erros do banco não são expostos. Cota não substitui autenticação, MFA, idempotência, isolamento ou flags.

Não cobre login/signup direto no Supabase, tráfego sem bearer válido, /health, webhooks e proteção de borda contra DDoS. A validação remota do token acontece antes deste limite; ataques à autenticação exigem controle de borda/Supabase separado. Webhooks mantêm autenticação própria e precisam política própria para evitar perda de eventos. Limites de corpo existentes permanecem.

Tabela protegida por RLS e privilégios revogados de public/anon/authenticated. Guarda UUID, bucket, início de janela e contador saturado, sem bearer, email ou IP. Até duas linhas por identidade usada; mantém-se entre reinícios, sem limpeza automática nesta versão. Reavaliar retenção ao ampliar o piloto.

Aceitação staging: todas as flags de movimentação continuam false. Habilitar apenas API_RATE_LIMITS_ENABLED na API; consultar /v1/me com conta de teste até observar 429, conferir Retry-After e retomar após a janela. Nenhuma transferência precisa ser criada. Não usar conta do operador para saturar a cota. /health deve continuar 200. Desabilitar somente para diagnóstico controlado, não como substituto da correção de falhas do contador.
