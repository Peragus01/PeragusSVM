# Peragus — Onda 2 de UX/UI do frontend

Branch: `feat/frontend-ux-wave-2`. Base: `feat/frontend-mvp-integration` (PR #31 ainda aberto). Esta etapa afeta **somente `app/frontend/`** e não modifica serviços externos, backend, banco, smart contracts, segredos ou infraestrutura.

## Objetivo

Transformar a primeira versão do frontend dark da Peragus em uma experiência orientada a novos usuários. A comunicação evita conceitos blockchain desnecessários e não deve induzir pagamentos, verificações ou entregas fictícias. O desenho segue a proposta de dashboard aprovada: preparação da conta em destaque, atalhos para carteira e histórico, e prévia de compra controlada.

## Mudanças

1. **Visão geral:** card de ativação com três passos, progresso derivado de sessão, KYC e conexão de carteira Devnet. O progresso representa somente estes passos, não aprovação de operações.
2. **Compra:** fluxo Valor → Revisão → Pagamento, com valor BRL validado, sem cotação inventada, sem taxa fictícia, sem emissão de Pix, sem execução financeira. CTA do passo final permanece desabilitado. Valores sugestivos são apenas exemplos.
3. **Verificação de identidade:** títulos, mensagens e orientações por `verification_status` de `/v1/me`. Conta suspensa prevalece sobre estado KYC. Não há upload de documentos ou aprovação no navegador.
4. **Navegação:** manter os sete destinos da sidebar aprovada, destacando `Comprar USDT` como `Prévia`, separação entre principal e conta, estados ativos, menu acessível no mobile, atalho de teclado para conteúdo.
5. **Mobile:** cartões legíveis para operações, mantendo a tabela no desktop. Fluxos de estorno, consultas paginadas e permissões da primeira versão permanecem preservados.
6. **Acessibilidade:** foco visível, navegação por teclado e Escape no menu, barra de progresso semântico, controles com textos e tamanhos de toque adequados.

## Contratos e limitações

- Não existe endpoint aprovado de checkout de Pix utilizável pelo frontend nessa branch. O wizard é **demonstrativo**: nenhuma transação ou orçamento financeiro real.
- A conexão Devnet não autentica o cliente nem comprova titularidade de carteira em Mainnet.
- Acompanhamento de KYC vem exclusivamente do servidor e não indica, isoladamente, habilitação de operações.
- O histórico de operações segue usando o cliente autenticado e preserva os estados e pedidos de estorno existentes.
- O valor informado no wizard não é persistido, cotado ou transmitido ao backend.

## Verificação

Executar no diretório `app/frontend/`:

```sh
npm ci
npm run typecheck
npm test
npm run lint
npm run build
```

Conferir visualmente em larguras aproximadas de 360, 390, 768, 1024 e 1440 px, além de navegação apenas por teclado, fechamento do menu via Escape, estados KYC distintos e pedidos de estorno no histórico.

Não realizar merge sem revisão e autorização. Base da branch de UX: PR #31 de frontend. Se a primeira versão for incorporada à `develop`, retargetar o PR de UX para `develop` após resolver possíveis conflitos, mantendo o diff restrito ao frontend.
