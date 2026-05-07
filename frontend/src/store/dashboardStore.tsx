"use client";

/**
 * dashboardStore — global Looker Studio filter state.
 *
 * Uses React Context + useReducer (no Zustand).
 * State flows:  AITerminal (ui_action) → dispatchUiAction → LookerEmbed URL
 *               AnalystSidebar (company select) → setCompany → LookerEmbed URL
 *
 * Provider must wrap the analyst dashboard page.
 */

import {
  createContext,
  useContext,
  useReducer,
  useCallback,
  type ReactNode,
  type Dispatch,
} from "react";

// ── State shape ───────────────────────────────────────────────────────────────

export interface DashboardFilter {
  company: string | null;
  kpi:     string | null;
  period:  string | null;
}

export interface DashboardState {
  filter:     DashboardFilter;
  lastAction: "SET_FILTER" | "SET_COMPANY" | "RESET" | null;
}

// ── Actions ───────────────────────────────────────────────────────────────────

type DashboardAction =
  | { type: "SET_FILTER";  params: Partial<DashboardFilter> }
  | { type: "SET_COMPANY"; company: string | null }
  | { type: "RESET" };

// ── Reducer ───────────────────────────────────────────────────────────────────

const initialState: DashboardState = {
  filter:     { company: null, kpi: null, period: null },
  lastAction: null,
};

function reducer(state: DashboardState, action: DashboardAction): DashboardState {
  switch (action.type) {
    case "SET_FILTER":
      return { filter: { ...state.filter, ...action.params }, lastAction: "SET_FILTER" };
    case "SET_COMPANY":
      return {
        filter:     { ...state.filter, company: action.company },
        lastAction: "SET_COMPANY",
      };
    case "RESET":
      return initialState;
    default:
      return state;
  }
}

// ── Context ───────────────────────────────────────────────────────────────────

export interface UiAction {
  action: string;
  params: Record<string, string>;
}

interface DashboardContextValue {
  state:            DashboardState;
  dispatch:         Dispatch<DashboardAction>;
  /** Called by AITerminal when Gemini emits <!--ACTION:{...}--> */
  dispatchUiAction: (uiAction: UiAction) => void;
  /** Called by sidebar / page when analyst selects a company */
  setCompany:       (company: string | null) => void;
}

const DashboardContext = createContext<DashboardContextValue | null>(null);

// ── Provider ──────────────────────────────────────────────────────────────────

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const dispatchUiAction = useCallback((uiAction: UiAction) => {
    if (uiAction.action === "SET_FILTER") {
      dispatch({
        type:   "SET_FILTER",
        params: {
          company: uiAction.params.company  || null,
          kpi:     uiAction.params.kpi      || null,
          period:  uiAction.params.period   || null,
        },
      });
    }
  }, []);

  const setCompany = useCallback((company: string | null) => {
    dispatch({ type: "SET_COMPANY", company });
  }, []);

  return (
    <DashboardContext.Provider value={{ state, dispatch, dispatchUiAction, setCompany }}>
      {children}
    </DashboardContext.Provider>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useDashboardStore(): DashboardContextValue {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error("useDashboardStore must be used within a DashboardProvider");
  return ctx;
}
