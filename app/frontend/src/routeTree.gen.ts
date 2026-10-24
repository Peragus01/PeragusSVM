/* eslint-disable */
// @ts-nocheck
// Generated route tree: TanStack Router may regenerate this file during vite dev/build.

import { Route as rootRouteImport } from './routes/__root'
import { Route as IndexRouteImport } from './routes/index'
import { Route as DevelopersRouteImport } from './routes/developers'
import { Route as SettlementsRouteImport } from './routes/settlements'
import { Route as ApiSplatRouteImport } from './routes/api/$'
import { Route as LoginRouteImport } from './routes/login'
import { Route as CadastroRouteImport } from './routes/cadastro'
import { Route as RecuperarSenhaRouteImport } from './routes/recuperar-senha'
import { Route as AppRouteImport } from './routes/app'
import { Route as AppIndexRouteImport } from './routes/app.index'
import { Route as AppOperacoesRouteImport } from './routes/app.operacoes'
import { Route as AppOperacoesIndexRouteImport } from './routes/app.operacoes.index'
import { Route as AppOperacoesIdRouteImport } from './routes/app.operacoes.$id'
import { Route as AppComprarRouteImport } from './routes/app.comprar-usdt'
import { Route as AppCarteiraRouteImport } from './routes/app.carteira'
import { Route as AppMinhaContaRouteImport } from './routes/app.minha-conta'
import { Route as AppAuditoriaRouteImport } from './routes/app.auditoria'

const IndexRoute = IndexRouteImport.update({ id: '/', path: '/', getParentRoute: () => rootRouteImport } as any)
const DevelopersRoute = DevelopersRouteImport.update({ id: '/developers', path: '/developers', getParentRoute: () => rootRouteImport } as any)
const SettlementsRoute = SettlementsRouteImport.update({ id: '/settlements', path: '/settlements', getParentRoute: () => rootRouteImport } as any)
const ApiSplatRoute = ApiSplatRouteImport.update({ id: '/api/$', path: '/api/$', getParentRoute: () => rootRouteImport } as any)
const LoginRoute = LoginRouteImport.update({ id: '/login', path: '/login', getParentRoute: () => rootRouteImport } as any)
const CadastroRoute = CadastroRouteImport.update({ id: '/cadastro', path: '/cadastro', getParentRoute: () => rootRouteImport } as any)
const RecuperarSenhaRoute = RecuperarSenhaRouteImport.update({ id: '/recuperar-senha', path: '/recuperar-senha', getParentRoute: () => rootRouteImport } as any)
const AppRoute = AppRouteImport.update({ id: '/app', path: '/app', getParentRoute: () => rootRouteImport } as any)
const AppIndexRoute = AppIndexRouteImport.update({ id: '/', path: '/', getParentRoute: () => AppRoute } as any)
const AppOperacoesRoute = AppOperacoesRouteImport.update({ id: '/operacoes', path: '/operacoes', getParentRoute: () => AppRoute } as any)
const AppOperacoesIndexRoute = AppOperacoesIndexRouteImport.update({ id: '/', path: '/', getParentRoute: () => AppOperacoesRoute } as any)
const AppOperacoesIdRoute = AppOperacoesIdRouteImport.update({ id: '/$id', path: '/$id', getParentRoute: () => AppOperacoesRoute } as any)
const AppComprarRoute = AppComprarRouteImport.update({ id: '/comprar-usdt', path: '/comprar-usdt', getParentRoute: () => AppRoute } as any)
const AppCarteiraRoute = AppCarteiraRouteImport.update({ id: '/carteira', path: '/carteira', getParentRoute: () => AppRoute } as any)
const AppMinhaContaRoute = AppMinhaContaRouteImport.update({ id: '/minha-conta', path: '/minha-conta', getParentRoute: () => AppRoute } as any)
const AppAuditoriaRoute = AppAuditoriaRouteImport.update({ id: '/auditoria', path: '/auditoria', getParentRoute: () => AppRoute } as any)

const AppOperacoesRouteWithChildren = AppOperacoesRoute._addFileChildren({ AppOperacoesIndexRoute, AppOperacoesIdRoute })
const AppRouteWithChildren = AppRoute._addFileChildren({ AppIndexRoute, AppOperacoesRoute: AppOperacoesRouteWithChildren, AppComprarRoute, AppCarteiraRoute, AppMinhaContaRoute, AppAuditoriaRoute })

export interface FileRoutesByFullPath {
  '/': typeof IndexRoute
  '/developers': typeof DevelopersRoute
  '/settlements': typeof SettlementsRoute
  '/api/$': typeof ApiSplatRoute
  '/login': typeof LoginRoute
  '/cadastro': typeof CadastroRoute
  '/recuperar-senha': typeof RecuperarSenhaRoute
  '/app': typeof AppRoute
  '/app/': typeof AppIndexRoute
  '/app/operacoes': typeof AppOperacoesRoute
  '/app/operacoes/': typeof AppOperacoesIndexRoute
  '/app/operacoes/$id': typeof AppOperacoesIdRoute
  '/app/comprar-usdt': typeof AppComprarRoute
  '/app/carteira': typeof AppCarteiraRoute
  '/app/minha-conta': typeof AppMinhaContaRoute
  '/app/auditoria': typeof AppAuditoriaRoute
}
export interface FileRoutesByTo {
  '/': typeof IndexRoute
  '/developers': typeof DevelopersRoute
  '/settlements': typeof SettlementsRoute
  '/api/$': typeof ApiSplatRoute
  '/login': typeof LoginRoute
  '/cadastro': typeof CadastroRoute
  '/recuperar-senha': typeof RecuperarSenhaRoute
  '/app': typeof AppRoute
  '/app/operacoes': typeof AppOperacoesRoute
  '/app/operacoes/$id': typeof AppOperacoesIdRoute
  '/app/comprar-usdt': typeof AppComprarRoute
  '/app/carteira': typeof AppCarteiraRoute
  '/app/minha-conta': typeof AppMinhaContaRoute
  '/app/auditoria': typeof AppAuditoriaRoute
}
export interface FileRoutesById {
  __root__: typeof rootRouteImport
  '/': typeof IndexRoute
  '/developers': typeof DevelopersRoute
  '/settlements': typeof SettlementsRoute
  '/api/$': typeof ApiSplatRoute
  '/login': typeof LoginRoute
  '/cadastro': typeof CadastroRoute
  '/recuperar-senha': typeof RecuperarSenhaRoute
  '/app': typeof AppRoute
  '/app/': typeof AppIndexRoute
  '/app/operacoes': typeof AppOperacoesRoute
  '/app/operacoes/': typeof AppOperacoesIndexRoute
  '/app/operacoes/$id': typeof AppOperacoesIdRoute
  '/app/comprar-usdt': typeof AppComprarRoute
  '/app/carteira': typeof AppCarteiraRoute
  '/app/minha-conta': typeof AppMinhaContaRoute
  '/app/auditoria': typeof AppAuditoriaRoute
}
export interface FileRouteTypes {
  fileRoutesByFullPath: FileRoutesByFullPath
  fullPaths: '/' | '/developers' | '/settlements' | '/api/$' | '/login' | '/cadastro' | '/recuperar-senha' | '/app' | '/app/' | '/app/operacoes' | '/app/operacoes/' | '/app/operacoes/$id' | '/app/comprar-usdt' | '/app/carteira' | '/app/minha-conta' | '/app/auditoria'
  fileRoutesByTo: FileRoutesByTo
  to: '/' | '/developers' | '/settlements' | '/api/$' | '/login' | '/cadastro' | '/recuperar-senha' | '/app' | '/app/operacoes' | '/app/operacoes/$id' | '/app/comprar-usdt' | '/app/carteira' | '/app/minha-conta' | '/app/auditoria'
  id: '__root__' | '/' | '/developers' | '/settlements' | '/api/$' | '/login' | '/cadastro' | '/recuperar-senha' | '/app' | '/app/' | '/app/operacoes' | '/app/operacoes/' | '/app/operacoes/$id' | '/app/comprar-usdt' | '/app/carteira' | '/app/minha-conta' | '/app/auditoria'
  fileRoutesById: FileRoutesById
}
export interface RootRouteChildren {
  IndexRoute: typeof IndexRoute
  DevelopersRoute: typeof DevelopersRoute
  SettlementsRoute: typeof SettlementsRoute
  ApiSplatRoute: typeof ApiSplatRoute
  LoginRoute: typeof LoginRoute
  CadastroRoute: typeof CadastroRoute
  RecuperarSenhaRoute: typeof RecuperarSenhaRoute
  AppRoute: typeof AppRouteWithChildren
}

declare module '@tanstack/react-router' {
  interface FileRoutesByPath {
    '/': { id: '/'; path: '/'; fullPath: '/'; preLoaderRoute: typeof IndexRouteImport; parentRoute: typeof rootRouteImport }
    '/developers': { id: '/developers'; path: '/developers'; fullPath: '/developers'; preLoaderRoute: typeof DevelopersRouteImport; parentRoute: typeof rootRouteImport }
    '/settlements': { id: '/settlements'; path: '/settlements'; fullPath: '/settlements'; preLoaderRoute: typeof SettlementsRouteImport; parentRoute: typeof rootRouteImport }
    '/api/$': { id: '/api/$'; path: '/api/$'; fullPath: '/api/$'; preLoaderRoute: typeof ApiSplatRouteImport; parentRoute: typeof rootRouteImport }
    '/login': { id: '/login'; path: '/login'; fullPath: '/login'; preLoaderRoute: typeof LoginRouteImport; parentRoute: typeof rootRouteImport }
    '/cadastro': { id: '/cadastro'; path: '/cadastro'; fullPath: '/cadastro'; preLoaderRoute: typeof CadastroRouteImport; parentRoute: typeof rootRouteImport }
    '/recuperar-senha': { id: '/recuperar-senha'; path: '/recuperar-senha'; fullPath: '/recuperar-senha'; preLoaderRoute: typeof RecuperarSenhaRouteImport; parentRoute: typeof rootRouteImport }
    '/app': { id: '/app'; path: '/app'; fullPath: '/app'; preLoaderRoute: typeof AppRouteImport; parentRoute: typeof rootRouteImport }
    '/app/': { id: '/'; path: '/'; fullPath: '/app/'; preLoaderRoute: typeof AppIndexRouteImport; parentRoute: typeof AppRouteImport }
    '/app/operacoes': { id: '/operacoes'; path: '/operacoes'; fullPath: '/app/operacoes'; preLoaderRoute: typeof AppOperacoesRouteImport; parentRoute: typeof AppRouteImport }
    '/app/operacoes/': { id: '/'; path: '/'; fullPath: '/app/operacoes/'; preLoaderRoute: typeof AppOperacoesIndexRouteImport; parentRoute: typeof AppOperacoesRouteImport }
    '/app/operacoes/$id': { id: '/$id'; path: '/$id'; fullPath: '/app/operacoes/$id'; preLoaderRoute: typeof AppOperacoesIdRouteImport; parentRoute: typeof AppOperacoesRouteImport }
    '/app/comprar-usdt': { id: '/comprar-usdt'; path: '/comprar-usdt'; fullPath: '/app/comprar-usdt'; preLoaderRoute: typeof AppComprarRouteImport; parentRoute: typeof AppRouteImport }
    '/app/carteira': { id: '/carteira'; path: '/carteira'; fullPath: '/app/carteira'; preLoaderRoute: typeof AppCarteiraRouteImport; parentRoute: typeof AppRouteImport }
    '/app/minha-conta': { id: '/minha-conta'; path: '/minha-conta'; fullPath: '/app/minha-conta'; preLoaderRoute: typeof AppMinhaContaRouteImport; parentRoute: typeof AppRouteImport }
    '/app/auditoria': { id: '/auditoria'; path: '/auditoria'; fullPath: '/app/auditoria'; preLoaderRoute: typeof AppAuditoriaRouteImport; parentRoute: typeof AppRouteImport }
  }
}
const rootRouteChildren: RootRouteChildren = {
  IndexRoute: IndexRoute,
  DevelopersRoute: DevelopersRoute,
  SettlementsRoute: SettlementsRoute,
  ApiSplatRoute: ApiSplatRoute,
  LoginRoute: LoginRoute,
  CadastroRoute: CadastroRoute,
  RecuperarSenhaRoute: RecuperarSenhaRoute,
  AppRoute: AppRouteWithChildren,
}
export const routeTree = rootRouteImport._addFileChildren(rootRouteChildren)._addFileTypes<FileRouteTypes>()

import type { getRouter } from './router.tsx'
import type { startInstance } from './start.ts'
declare module '@tanstack/react-start' {
  interface Register {
    ssr: true
    router: Awaited<ReturnType<typeof getRouter>>
    config: Awaited<ReturnType<typeof startInstance.getOptions>>
  }
}
