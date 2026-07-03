import { Injectable } from '@angular/core';

/**
 * Pré-processamento de imagens para melhorar o OCR.
 *
 * Documentos como o "cartão CNPJ" costumam falhar no Tesseract quando a imagem
 * é pequena, tem pouco contraste ou fundo colorido. Aqui aplicamos, 100% no
 * navegador (canvas, sem libs externas):
 *   1. upscale  — aproxima o texto de um tamanho confortável para o OCR;
 *   2. cinza    — remove cor (o Tesseract trabalha em luminância);
 *   3. contraste — realça os dígitos/letras contra o fundo.
 */
@Injectable({ providedIn: 'root' })
export class ImageService {
  /** Maior dimensão alvo após o upscale (px). Texto maior => OCR melhor. */
  private readonly TARGET_LONG_EDGE = 2200;
  /** Nunca reduzimos (perderia detalhe); ampliamos no máximo 3x. */
  private readonly MIN_SCALE = 1;
  private readonly MAX_SCALE = 3;

  /**
   * Carrega o arquivo de imagem, aplica o pré-processamento e devolve o canvas
   * pronto para ser passado ao OCR.
   */
  async preprocessToCanvas(file: File): Promise<HTMLCanvasElement> {
    const source = await this.loadImage(file);

    // Calcula a escala: amplia imagens pequenas até TARGET_LONG_EDGE, mas
    // respeitando os limites (não reduz, não passa de 3x).
    const longEdge = Math.max(source.width, source.height);
    const scale = Math.min(
      this.MAX_SCALE,
      Math.max(this.MIN_SCALE, this.TARGET_LONG_EDGE / longEdge),
    );

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(source.width * scale);
    canvas.height = Math.round(source.height * scale);

    // `willReadFrequently` evita penalidade ao chamar getImageData logo abaixo.
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Não foi possível obter o contexto 2D do canvas.');

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

    this.grayscaleAndBinarize(ctx, canvas.width, canvas.height);

    // Libera o bitmap decodificado (apenas ImageBitmap tem .close()).
    if ('close' in source) source.close();

    return canvas;
  }

  /** Decodifica o File. Usa createImageBitmap (rápido) com fallback para <img>. */
  private async loadImage(file: File): Promise<ImageBitmap | HTMLImageElement> {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file);
    }
    const url = URL.createObjectURL(file);
    try {
      return await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Falha ao carregar a imagem.'));
        img.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Converte para tons de cinza (luminância Rec. 601) e binariza com limiar
   * automático de **Otsu** — o limiar que melhor separa "tinta" de "fundo".
   * O resultado é preto-e-branco nítido, o formato que o Tesseract lê melhor.
   *
   * Otsu é global (um limiar para a imagem toda). Em fotos com sombra/iluminação
   * desigual, um limiar ADAPTATIVO por região (Sauvola) tende a ser melhor —
   * fica como próximo passo se necessário.
   */
  private grayscaleAndBinarize(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
  ): void {
    const image = ctx.getImageData(0, 0, width, height);
    const data = image.data;
    const total = width * height;

    // 1) Cinza + histograma de 256 níveis.
    const gray = new Uint8Array(total);
    const hist = new Array(256).fill(0);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const g =
        (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
      gray[p] = g;
      hist[g]++;
    }

    // 2) Limiar de Otsu: maximiza a variância entre as duas classes.
    let sumTotal = 0;
    for (let t = 0; t < 256; t++) sumTotal += t * hist[t];

    let sumBg = 0;
    let weightBg = 0;
    let maxVar = -1;
    let threshold = 127;
    for (let t = 0; t < 256; t++) {
      weightBg += hist[t];
      if (weightBg === 0) continue;
      const weightFg = total - weightBg;
      if (weightFg === 0) break;

      sumBg += t * hist[t];
      const meanBg = sumBg / weightBg;
      const meanFg = (sumTotal - sumBg) / weightFg;
      const between = weightBg * weightFg * (meanBg - meanFg) ** 2;
      if (between > maxVar) {
        maxVar = between;
        threshold = t;
      }
    }

    // 3) Aplica: abaixo do limiar => preto, acima => branco.
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const v = gray[p] < threshold ? 0 : 255;
      data[i] = data[i + 1] = data[i + 2] = v;
    }
    ctx.putImageData(image, 0, 0);
  }
}
