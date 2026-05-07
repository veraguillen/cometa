// Utilidades para procesar datos financieros

export interface ParsedFinancialValue {
  value: number;
  unit?: string;
  original: string;
}

/**
 * Convierte strings financieros a números limpios
 * Ejemplos:
 * "36%" -> { value: 36, unit: "%" }
 * "$9.7M" -> { value: 9.7, unit: "M" }
 * "-0.74%" -> { value: -0.74, unit: "%" }
 */
export function parseFinancialValue(value: string | undefined | null): ParsedFinancialValue {
  if (!value) {
    return { value: 0, original: '' };
  }

  const original = value.trim();
  console.log(" Parseando valor financiero:", original);
  
  // Manejar porcentajes
  if (original.includes('%')) {
    const numValue = parseFloat(original.replace('%', '').replace(',', '.'));
    const result = {
      value: isNaN(numValue) ? 0 : numValue,
      unit: '%',
      original
    };
    console.log(" Valor parseado (%):", result);
    return result;
  }
  
  // Manejar valores monetarios
  if (original.includes('$')) {
    // Extraer el número y la unidad (M, K, B)
    const cleanValue = original.replace('$', '').replace(',', '').trim();
    const match = cleanValue.match(/^(-?\d+\.?\d*)([A-Z])?$/);
    
    if (match) {
      const numValue = parseFloat(match[1]);
      const unit = match[2] || '';
      const result = {
        value: isNaN(numValue) ? 0 : numValue,
        unit,
        original
      };
      console.log(" Valor parseado ($):", result);
      return result;
    }
  }
  
  // Manejar números simples
  const numValue = parseFloat(original.replace(',', '.'));
  const result = {
    value: isNaN(numValue) ? 0 : numValue,
    original
  };
  console.log(" Valor parseado (simple):", result);
  return result;
}

/**
 * Formatea un número para visualización
 */
export function formatFinancialValue(value: number, unit?: string): string {
  if (unit === '%') {
    return `${value.toFixed(2)}%`;
  }
  
  if (unit === 'M') {
    return `$${value.toFixed(1)}M`;
  }
  
  if (unit === 'K') {
    return `$${value.toFixed(0)}K`;
  }
  
  if (unit === 'B') {
    return `$${value.toFixed(2)}B`;
  }
  
  return value.toString();
}

/**
 * Determina el color basado en el valor y tipo de métrica
 */
export function getMetricColor(value: number, metricType: string): string {
  switch (metricType) {
    case 'revenueGrowth':
      return value > 20 ? 'text-green-400' : value > 0 ? 'text-yellow-400' : 'text-red-400';
    
    case 'ebitdaMargin':
      return value > 10 ? 'text-green-400' : value > 0 ? 'text-yellow-400' : 'text-red-400';
    
    case 'grossMargin':
      return value > 50 ? 'text-green-400' : value > 20 ? 'text-yellow-400' : 'text-red-400';
    
    case 'cashInBank':
    case 'annualCashFlow':
      return value > 0 ? 'text-green-400' : 'text-red-400';
    
    case 'workingCapitalDebt':
      return value < 5 ? 'text-green-400' : value < 10 ? 'text-yellow-400' : 'text-red-400';
    
    default:
      return 'text-white';
  }
}

/**
 * Formatea fecha relativa (hace X tiempo)
 */
export function formatRelativeDate(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);
  
  if (diffHours < 1) {
    return 'hace menos de 1 hora';
  }
  
  if (diffHours < 24) {
    return `hace ${diffHours} ${diffHours === 1 ? 'hora' : 'horas'}`;
  }
  
  if (diffDays < 30) {
    return `hace ${diffDays} ${diffDays === 1 ? 'día' : 'días'}`;
  }
  
  return date.toLocaleDateString();
}

/**
 * Trunca nombre de archivo
 */
export function truncateFilename(filename: string, maxLength: number = 30): string {
  if (filename.length <= maxLength) {
    return filename;
  }
  
  const extension = filename.split('.').pop() ?? '';
  const nameWithoutExt = filename.substring(0, filename.lastIndexOf('.'));

  if (nameWithoutExt.length <= maxLength - extension.length - 4) {
    return filename;
  }

  return `${nameWithoutExt.substring(0, maxLength - extension.length - 4)}...${extension}`;
}
