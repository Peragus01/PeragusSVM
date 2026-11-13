# Reset do fator MFA do operador (perda do autenticador)

O operador precisa de MFA (TOTP) para toda ação de dinheiro: AAL2 e código verificado há no máximo 300 s.
Se o autenticador for perdido, o operador fica bloqueado de ações sensíveis (isto é intencional). Não há recuperação
automática: o reset é **manual**, pelo painel do Supabase, e deve deixar registro de auditoria.

Aplica-se ao projeto de **produção** (`athwkklyvnaetotmancy`) e, com os mesmos passos, ao de staging (`lybdkqkbwlfwvmmvstzi`).
Com operador único, quem executa o reset é o próprio responsável (dono do projeto no Supabase), o que torna o
registro e o aviso à pessoa de confiança obrigatórios.

## Antes de começar

1. **Confirme a identidade e o motivo.** Autenticador perdido/trocado, e não suspeita de comprometimento. Se houver suspeita de
   comprometimento da conta (senha ou dispositivo), trate como incidente: primeiro **pause tudo** (chaves `new_operations`
   e `usdt_sends` — `operator-runbook.md` seção 1; se não conseguir por falta de MFA, desligue as flags de ambiente
   `CUSTOMER_PURCHASE_INTENTS_ENABLED` e `SANDBOX_WITHDRAWAL_EXECUTION_ENABLED` no Railway e reimplante), troque a senha e revogue sessões.
2. Avise a pessoa de confiança por canal fora do sistema (mensagem direta ou e-mail), dizendo que um reset será feito e por quê.
3. Tenha em mãos o e-mail e o UUID do usuário operador (o UUID está em `WITHDRAWAL_OPERATOR_USER_IDS`).

## Procedimento no painel do Supabase

1. Entre no painel do Supabase com a conta dona do projeto (a conta do painel tem MFA próprio; não use a conta de operador da Peragus aqui).
2. Abra o projeto de produção › **Authentication › Users** e localize o usuário pelo e-mail/UUID. Confira o UUID.
3. Abra o menu do usuário e remova o(s) fator(es) MFA (opção de remover/excluir fatores MFA do usuário). **Último recurso, só manual:** se o painel não oferecer a
   opção, e somente nesse caso, use o **SQL Editor** com uma consulta restrita ao UUID conferido (rode primeiro o `select` para ver o que será removido):

```sql
-- Conferir (substitua o UUID pelo valor conferido; nunca rode sem o filtro).
select id, factor_type, status, created_at
from auth.mfa_factors
where user_id = '<UUID-DO-OPERADOR>';

-- Remover somente depois de conferir o resultado acima.
delete from auth.mfa_factors
where user_id = '<UUID-DO-OPERADOR>';
```

4. Peça ao operador para encerrar a sessão (logout) e entrar de novo com e-mail e senha. Como o usuário está na
   allowlist de operadores, o **primeiro enrollment de MFA** é oferecido apenas a ele: escaneie o novo QR code no novo
   autenticador, confirme o código e guarde os dados de recuperação do app (backup do autenticador).
5. Teste: com o novo fator, abra `GET /v1/admin/runtime-controls` (somente leitura) com o novo JWT. Deve responder 200. `OPERATOR_MFA_STALE` indica que o código
   precisa ser verificado de novo; `WITHDRAWAL_OPERATOR_MFA_REQUIRED` indica que o fator ainda não está ativo.
6. Revogue sessões antigas do usuário (Authentication › Users › usuário › encerrar sessões), se disponível.

## Registro de auditoria (obrigatório)

Registre o reset **no mesmo dia**, em um local versionado fora do repositório público (planilha/arquivo privado do responsável)
e na observação da próxima revisão diária (`POST /v1/admin/daily-reviews`, campo `note`, sem dados pessoais). Conteúdo mínimo:

| Campo | Exemplo |
|---|---|
| Data e hora (America/Sao_Paulo) | 2026-11-14 10:32 |
| Projeto (produção/staging) | produção |
| UUID do usuário afetado | `<UUID>` (nunca o código TOTP ou QR) |
| Motivo | autenticador perdido (celular trocado) |
| Quem executou / quem foi avisado | responsável / pessoa de confiança, às 10:20 |
| Evidência | captura do painel mostrando a remoção do fator (sem segredos) e do teste da etapa 5 |
| Operações em andamento no momento | nenhuma / lista de IDs |
| Houve suspeita de comprometimento? | não (se sim, abrir incidente) |

Apague capturas que mostrem QR code ou segredo do TOTP. O Supabase mantém o log do projeto (Logs › Auth) com a remoção;
anexe o trecho se possível.

## Depois do reset

- Operações `awaiting_approval`/`approved` continuam válidas; aprovações antigas permanecem registradas. Reexecute a ação com MFA fresco.
- Se o reset ocorreu durante pausa por incidente, só religue as chaves depois de entender a causa.
- Revise o e-mail de alertas: mudança de chave durante o incidente gera e-mail à pessoa de confiança.
