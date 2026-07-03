import { ApplicationConfig } from '@angular/core';

/**
 * Configuração global da aplicação.
 *
 * Esta POC não precisa de router nem HttpClient — tudo roda no browser.
 * A ausência de HttpClient reforça o objetivo: nenhum dado sai do navegador.
 */
export const appConfig: ApplicationConfig = {
  providers: [],
};
