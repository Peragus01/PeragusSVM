# Experiência do cliente Peragus

Esta alteração aplica as referências de navegação e hierarquia enviadas pelo usuário ao frontend existente, com componentes e identidade próprios da Peragus. O layout usa medidas em CSS para zoom de 100%; não utiliza zoom ou transformações para encolher a página.

## Escopo

- Página pública original em português, com entrada para login visível, acesso por convite, explicação do piloto e dúvidas frequentes. A raiz não monta mais o shell técnico, o provedor de conexão, o cartão de health ou a conexão de carteira.
- Login e recuperação com novo layout dividido no desktop, formulário único no celular e ação de mostrar/ocultar senha. A autenticação e a sessão em memória permanecem iguais. O cadastro continua bloqueado até existir integração de adesão; nenhuma criação de conta fictícia foi adicionada.
- Navegação interna agrupada, menu no celular com fechamento por Escape e links ocultos inertes quando o menu está fechado, textos legíveis e alvos de toque maiores.
- Dashboard, conta/KYC, carteira, evidências, histórico e detalhe compartilham a nova apresentação. Perfil local continua separado da identidade do provedor.
- Compra dividida visualmente em valor, revisão e registro. Mantém os mesmos endpoints, validações, IDs persistidos e proteção contra duplicidade; formata os valores em português. Referências técnicas e evidências extensas ficam em seções expansíveis.
- Histórico com filtros locais de período e etapa. A interface informa que os filtros abrangem apenas os registros já carregados; paginação continua disponível.

Não foram criados saldos em BRL, contas bancárias, venda de criptomoedas, transferências Pix, pagamentos de boletos ou comissões. A integração de cobrança Pix no frontend permanece uma etapa funcional posterior. Nenhuma flag foi alterada e nenhuma chamada a provedores reais foi necessária para testar este PR.

## Validação

TypeScript, build e testes Vitest. Verificação em navegador local com respostas sintéticas para autenticação, identidade, cotação e intenção: home, login, dashboard, compra e histórico; larguras 1440 e 390 pixels, escala 1. As rotas de criação chamadas foram apenas quotes e purchase-intents; sair e voltar pelo histórico do navegador manteve a proteção de login. A validação real de integração no Preview deve ser refeita após o merge.

A fonte Manrope é servida localmente, com licença OFL em `public/fonts/Manrope-LICENSE.txt`, sem depender de Google Fonts para carregar a interface.

## Arte da capa

Arquivo: `public/peragus-life.webp`. Fotografia criada com a ferramenta integrada image_gen e comprimida para WebP; não reutiliza fotos ou identidade da 4P. Prompt: “Original premium editorial photograph, landscape 16:9. A young Latin American small business owner in a modern cafe in São Paulo, relaxed looking at a smartphone, positioned on the right third. Dark navy ambient tones with subtle cobalt blue light, warm natural skin tones, shallow depth of field. Left half dark uncluttered cafe interior with negative space for an HTML headline. No text, logos, watermarks, crypto coins or readable UI.”

## Publicação

Merge na branch `feat/frontend-mvp-integration`, seguido de Preview dessa branch com as variáveis já existentes. Não requer deploy do backend, migrations ou habilitação de flags financeiras. Validar navegação, teclado, menu mobile, login/logout e os registros existentes com as flags de escrita desligadas. Não promover a produção nesta etapa.
