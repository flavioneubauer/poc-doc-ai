import { bootstrapApplication } from '@angular/platform-browser';

import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';

// Ponto de entrada da aplicação standalone (sem NgModule raiz).
bootstrapApplication(AppComponent, appConfig).catch((err) =>
  console.error('Falha ao inicializar a aplicação:', err),
);
