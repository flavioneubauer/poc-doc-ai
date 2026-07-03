import { JsonPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { StatusDocumento } from '../../models/document.model';
import { DocumentProcessingService } from '../../services/document-processing.service';

/**
 * Coluna 3 — "Dados Estruturados".
 *
 * Mostra os campos extraídos em uma tabela amigável e o JSON formatado
 * (o mesmo objeto, exibido com o pipe `json`).
 */
@Component({
  selector: 'app-structured-data',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [JsonPipe],
  template: `
    <h2>🧩 Dados Estruturados</h2>

    @if (svc.structured(); as d) {
      <table class="kv">
        <tbody>
          <tr>
            <th>Tipo do Documento</th>
            <td>{{ d.tipoDocumento }}</td>
          </tr>
          <tr>
            <th>CNPJ</th>
            <td>{{ d.cnpj ?? '—' }}</td>
          </tr>
          <tr>
            <th>Razão Social</th>
            <td>{{ d.razaoSocial ?? '—' }}</td>
          </tr>
          <tr>
            <th>Data de Validade</th>
            <td>{{ d.dataValidade ?? '—' }}</td>
          </tr>
          <tr>
            <th>Datas encontradas</th>
            <td>{{ d.datas.length ? d.datas.join(', ') : '—' }}</td>
          </tr>
          <tr>
            <th>Status</th>
            <td>
              <span class="badge" [class]="badgeClass(d.status)">{{ d.status }}</span>
            </td>
          </tr>
        </tbody>
      </table>

      @if (d.sensiveis; as s) {
        <h3>🔒 Dados sensíveis detectados</h3>
        <p class="hint">
          Documento fora dos tipos conhecidos — extração best-effort de PII e
          dados de saúde (tudo processado localmente).
        </p>
        <table class="kv">
          <tbody>
            <tr><th>CPF</th><td>{{ s.cpf ?? '—' }}</td></tr>
            <tr><th>Data de nascimento</th><td>{{ s.dataNascimento ?? '—' }}</td></tr>
            <tr><th>E-mail</th><td>{{ s.email ?? '—' }}</td></tr>
            <tr><th>Telefone</th><td>{{ s.telefone ?? '—' }}</td></tr>
            <tr><th>Contato</th><td>{{ s.contato ?? '—' }}</td></tr>
            <tr><th>Endereço</th><td>{{ s.endereco ?? '—' }}</td></tr>
            <tr><th>Nome da mãe</th><td>{{ s.nomeMae ?? '—' }}</td></tr>
            <tr><th>Cartão SUS</th><td>{{ s.cartaoSus ?? '—' }}</td></tr>
            <tr><th>Convênio</th><td>{{ s.convenio ?? '—' }}</td></tr>
            <tr><th>Hipótese diagnóstica</th><td>{{ s.hipoteseDiagnostica ?? '—' }}</td></tr>
            <tr>
              <th>Dados de saúde</th>
              <td>
                @if (s.dadosSaude.length) {
                  <ul class="saude">
                    @for (item of s.dadosSaude; track item) {
                      <li>{{ item }}</li>
                    }
                  </ul>
                } @else {
                  —
                }
              </td>
            </tr>
          </tbody>
        </table>
      }

      <h3>JSON</h3>
      <pre class="json">{{ d | json }}</pre>
    } @else {
      <p class="empty">Os dados extraídos aparecerão aqui após o OCR.</p>
    }
  `,
})
export class StructuredDataComponent {
  protected readonly svc = inject(DocumentProcessingService);

  /** Define a cor do "badge" de status. */
  protected badgeClass(status: StatusDocumento): string {
    switch (status) {
      case 'Válido':
        return 'badge-ok';
      case 'Vencido':
        return 'badge-bad';
      default:
        return 'badge-neutral';
    }
  }
}
