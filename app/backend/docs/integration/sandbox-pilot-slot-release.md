# Liberação administrativa das vagas de teste

Ferramenta local para o administrador do banco staging fixado, sem rota HTTP, nova flag de runtime ou poderes para clientes. Não representa aprovação por operador MFA: a identidade de auditoria é `current_user` do Postgres. Não usar em produção.

Aplicar migration 031 antes da ferramenta. Manter PILOT_INVITES_ENABLED=false na API e worker durante toda a manutenção, aguardar deploy e manter flags financeiras e reconciliação desligadas. A ferramenta verifica a configuração local; o administrador verifica a configuração remota.

O plano JSON contém `request_id` UUID estável, `reason` de 10–300 caracteres e `expected`: array de objetos `{slot,admitted_user_id,current_invite_id}` com todas as vagas ocupadas esperadas. UUIDs de usuários são Auth IDs. Nunca incluir emails, tokens ou códigos de convite.

Executar com DOTENV_CONFIG_PATH=.env.staging: `node --import dotenv/config scripts/sandbox-pilot-slot-release.mjs plano.json --preview`. Não modifica dados. Após conferir, executar a mesma linha com `--apply` e variável SANDBOX_SLOT_RELEASE_CONFIRMATION=RELEASE_TEST_ADMISSIONS_ONLY. Manter o mesmo request_id em qualquer repetição.

A transação bloqueia as cinco vagas e confere o snapshot exato; rejeita convites issued e evidência divergente. Persiste snapshot, motivo, request_id, database_actor e data em tabela append-only antes de liberar vagas. Falha reverte auditoria e liberação. Replay nunca libera novos ocupantes. RLS revoga acesso de anon/authenticated.

Preserva perfis Auth/Peragus, KYC, histórico financeiro e convites redeemed imutáveis. Contas de teste existentes continuam acessíveis e não precisam de novo convite; não voltam a ocupar vagas automaticamente. Portanto, cinco vagas livres significam cinco novas admissões, não limite de cinco perfis totais. Não altera o slot de execução de retiradas, saldos ou provedor OZAV. Não reabre códigos resgatados.
