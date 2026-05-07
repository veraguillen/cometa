"use client";

/**
 * GeometricBackground — animated concentric circles + cube wireframes.
 * Fixed behind all content (z-0, pointer-events-none).
 * Uses CSS `var(--cometa-accent)` so it adapts to all three themes.
 */

import { motion } from "framer-motion";

export default function GeometricBackground() {
  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
      {/* Concentric rotating circles — top-right */}
      <motion.div
        className="geometric-circle w-[600px] h-[600px] -top-40 -right-40"
        animate={{ rotate: 360 }}
        transition={{ duration: 120, repeat: Infinity, ease: "linear" }}
      />
      <motion.div
        className="geometric-circle w-[400px] h-[400px] -top-20 -right-20"
        animate={{ rotate: -360 }}
        transition={{ duration: 90, repeat: Infinity, ease: "linear" }}
      />
      <motion.div
        className="geometric-circle w-[200px] h-[200px] top-0 right-0"
        animate={{ rotate: 360 }}
        transition={{ duration: 60, repeat: Infinity, ease: "linear" }}
      />

      {/* Bottom-left cube wireframes */}
      <div className="geometric-cube w-32 h-32 -bottom-8 -left-8 opacity-40" />
      <div className="geometric-cube w-48 h-48 bottom-12 left-12 opacity-20" />

      {/* Small floating accent dot */}
      <motion.div
        className="absolute bottom-1/3 right-1/4 w-2 h-2 rounded-full"
        style={{ background: "color-mix(in srgb, var(--cometa-accent) 30%, transparent)" }}
        animate={{ y: [-10, 10, -10], opacity: [0.3, 0.7, 0.3] }}
        transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
      />
    </div>
  );
}
