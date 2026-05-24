import { Outlet } from 'react-router-dom'

import { motion } from '@/lib/motion'

/**
 * Wraps the routed page content with a subtle fade/slide transition.
 * The wrapper is mounted once per shell render — page transitions on
 * URL change happen because each route's element re-creates the
 * outlet's children.
 */
export function AnimatedOutlet() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
    >
      <Outlet />
    </motion.div>
  )
}
