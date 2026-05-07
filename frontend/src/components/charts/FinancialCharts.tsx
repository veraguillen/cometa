"use client";

import { parseFinancialValue, formatFinancialValue } from '@/lib/financial-utils';

// Definir el tipo localmente para evitar importaciones circulares
type AnalysisResult = {
  id: string;
  data: any;
  date: string;
  metadata: {
    file_hash: string;
    original_filename: string;
    founder_email: string;
    processed_at: string;
    gcs_path: string;
  };
};

interface FinancialChartsProps {
  selectedResult: AnalysisResult | null;
  allResults: AnalysisResult[];
  showUSD?: boolean;
}

// Función helper extraída (temporalmente aquí hasta moverla a un archivo de utilidades)
function extractKeyMetrics(data: any) {
  const metrics = data?.financial_metrics_2025;
  
  return {
    revenueGrowth: metrics?.revenue_growth?.value,
    grossMargin: metrics?.profit_margins?.gross_profit_margin?.value,
    ebitdaMargin: metrics?.profit_margins?.ebitda_margin?.value,
    cashInBank: metrics?.cash_flow_indicators?.cash_in_bank_end_of_year?.value,
    annualCashFlow: metrics?.cash_flow_indicators?.annual_cash_flow?.value,
    workingCapitalDebt: metrics?.debt_ratios?.working_capital_debt?.value,
  };
}

export default function FinancialCharts({ selectedResult, allResults }: FinancialChartsProps) {
  // Datos para el gráfico de barras comparativo
  const comparisonData = allResults.map(result => {
    const metrics = extractKeyMetrics(result.data);
    const revenueGrowth = parseFinancialValue(metrics.revenueGrowth);
    const ebitdaMargin = parseFinancialValue(metrics.ebitdaMargin);
    
    
    return {
      name: result.metadata.original_filename.replace(/^[a-f0-9]+_/, '').substring(0, 20) + '...',
      revenueGrowth: revenueGrowth.value,
      ebitdaMargin: ebitdaMargin.value,
      originalRevenue: revenueGrowth.original,
      originalEbitda: ebitdaMargin.original
    };
  });


  // Datos para el análisis de márgenes del resultado seleccionado
  const marginAnalysis = selectedResult ? (() => {
    const metrics = extractKeyMetrics(selectedResult.data);
    const grossMargin = parseFinancialValue(metrics.grossMargin);
    const ebitdaMargin = parseFinancialValue(metrics.ebitdaMargin);
    
    
    return {
      grossMargin: grossMargin,
      ebitdaMargin: ebitdaMargin,
      netMargin: Math.max(0, grossMargin.value - Math.abs(ebitdaMargin.value))
    };
  })() : null;

  return (
    <div className="space-y-8">
      {/* Gráfico de Barras Comparativo */}
      <div>
        <h3 className="font-cometa-extralight text-white/60 text-xs tracking-[0.12em] mb-5">
          Comparativa de Rendimiento
        </h3>

        {comparisonData.length > 0 ? (
          <div className="space-y-3">
            {comparisonData.map((item, index) => (
              <div key={index} className="cometa-card-gradient rounded-2xl p-4">
                <h4 className="font-cometa-extralight text-white/40 text-xs tracking-[0.10em] mb-3">{item.name}</h4>

                <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-3">
                  <div>
                    <div className="font-cometa-extralight text-white/25 text-[10px] tracking-[0.10em] mb-1.5">Revenue Growth</div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-white/[0.04] rounded-full h-[3px] overflow-hidden">
                        <div
                          className="h-full transition-all duration-700"
                          style={{
                            width: `${Math.min(100, Math.max(0, item.revenueGrowth))}%`,
                            background: "linear-gradient(90deg, var(--cometa-accent) 0%, color-mix(in srgb, var(--cometa-accent) 0%, transparent) 100%)",
                          }}
                        />
                      </div>
                      <span className="font-cometa-extralight text-white text-xs min-w-[44px] text-right">
                        {item.revenueGrowth.toFixed(1)}%
                      </span>
                    </div>
                  </div>

                  <div>
                    <div className="font-cometa-extralight text-white/25 text-[10px] tracking-[0.10em] mb-1.5">EBITDA Margin</div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-white/[0.04] rounded-full h-[3px] overflow-hidden">
                        <div
                          className="h-full transition-all duration-700"
                          style={{
                            width: `${Math.min(100, Math.max(0, Math.abs(item.ebitdaMargin)))}%`,
                            background: item.ebitdaMargin >= 0
                              ? "linear-gradient(90deg, var(--cometa-accent) 0%, color-mix(in srgb, var(--cometa-accent) 0%, transparent) 100%)"
                              : "linear-gradient(90deg, #ef4444 0%, rgba(239,68,68,0) 100%)",
                          }}
                        />
                      </div>
                      <span className={`font-cometa-extralight text-xs min-w-[44px] text-right ${
                        item.ebitdaMargin >= 0 ? "text-white" : "text-red-400/70"
                      }`}>
                        {item.ebitdaMargin.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-center h-40">
            <p className="font-cometa-extralight text-white/20 text-sm">Sin datos comparativos</p>
          </div>
        )}
      </div>

      {/* Análisis de Márgenes */}
      {selectedResult && marginAnalysis && (
        <div>
          <h3 className="font-cometa-extralight text-white/60 text-xs tracking-[0.12em] mb-5">
            Márgenes · {selectedResult.metadata.original_filename.replace(/^[a-f0-9]+_/, '')}
          </h3>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="text-center">
              <div className="relative inline-flex items-center justify-center">
                <div className="w-32 h-32 rounded-full border-[1px] border-white/10"></div>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="font-cometa-extralight text-white" style={{ fontSize: "clamp(18px,3.5vw,26px)", letterSpacing: "-0.04em" }}>
                    {marginAnalysis.grossMargin.value.toFixed(1)}%
                  </span>
                  <span className="font-cometa-extralight text-white/35 text-[10px] tracking-[0.10em] mt-0.5">Gross</span>
                </div>
                <div
                  className="absolute inset-0 rounded-full transition-all duration-1000"
                  style={{
                    border: "1px solid transparent",
                    borderTopColor: "var(--cometa-accent)",
                    borderRightColor: "var(--cometa-accent)",
                    transform: `rotate(${(marginAnalysis.grossMargin.value / 100) * 360 - 90}deg)`,
                    clipPath: "polygon(50% 50%, 100% 0, 100% 100%, 50% 100%)",
                    filter: "drop-shadow(0 0 6px color-mix(in srgb, var(--cometa-accent) 50%, transparent))",
                  }}
                />
              </div>
              <p className="mt-4 font-cometa-extralight text-white/40 text-xs tracking-[0.08em]">Margen Bruto</p>
            </div>

            <div className="text-center">
              <div className="relative inline-flex items-center justify-center">
                <div className="w-32 h-32 rounded-full border-[1px] border-white/10"></div>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span
                    className="font-cometa-extralight"
                    style={{
                      fontSize: "clamp(18px,3.5vw,26px)",
                      letterSpacing: "-0.04em",
                      color: marginAnalysis.ebitdaMargin.value >= 0 ? "white" : "#ef4444",
                    }}
                  >
                    {marginAnalysis.ebitdaMargin.value.toFixed(1)}%
                  </span>
                  <span className="font-cometa-extralight text-white/35 text-[10px] tracking-[0.10em] mt-0.5">EBITDA</span>
                </div>
                <div
                  className="absolute inset-0 rounded-full transition-all duration-1000"
                  style={{
                    border: "1px solid transparent",
                    borderTopColor: marginAnalysis.ebitdaMargin.value >= 0 ? "var(--cometa-accent)" : "#ef4444",
                    borderRightColor: marginAnalysis.ebitdaMargin.value >= 0 ? "var(--cometa-accent)" : "#ef4444",
                    transform: `rotate(${(Math.abs(marginAnalysis.ebitdaMargin.value) / 100) * 360 - 90}deg)`,
                    clipPath: "polygon(50% 50%, 100% 0, 100% 100%, 50% 100%)",
                    filter: marginAnalysis.ebitdaMargin.value >= 0
                      ? "drop-shadow(0 0 6px color-mix(in srgb, var(--cometa-accent) 50%, transparent))"
                      : "drop-shadow(0 0 6px rgba(239,68,68,0.4))",
                  }}
                />
              </div>
              <p className="mt-4 font-cometa-extralight text-white/40 text-xs tracking-[0.08em]">Margen EBITDA</p>
            </div>

            <div className="text-center">
              <div className="relative inline-flex items-center justify-center">
                <div className="w-32 h-32 rounded-full border-[1px] border-white/10"></div>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="font-cometa-extralight text-white" style={{ fontSize: "clamp(18px,3.5vw,26px)", letterSpacing: "-0.04em" }}>
                    {marginAnalysis.netMargin.toFixed(1)}%
                  </span>
                  <span className="font-cometa-extralight text-white/35 text-[10px] tracking-[0.10em] mt-0.5">Net</span>
                </div>
                <div
                  className="absolute inset-0 rounded-full transition-all duration-1000"
                  style={{
                    border: "1px solid transparent",
                    borderTopColor: "var(--cometa-accent)",
                    borderRightColor: "var(--cometa-accent)",
                    transform: `rotate(${(marginAnalysis.netMargin / 100) * 360 - 90}deg)`,
                    clipPath: "polygon(50% 50%, 100% 0, 100% 100%, 50% 100%)",
                    filter: "drop-shadow(0 0 6px color-mix(in srgb, var(--cometa-accent) 50%, transparent))",
                  }}
                />
              </div>
              <p className="mt-4 font-cometa-extralight text-white/40 text-xs tracking-[0.08em]">Margen Neto</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
