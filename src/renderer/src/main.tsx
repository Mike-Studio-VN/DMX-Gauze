import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

const root = createRoot(document.getElementById('root')!)
const render = (view: ReactNode) => root.render(<StrictMode>{view}</StrictMode>)

const startup = window.gauzeStartup
if (startup) {
  void import('./StartupScreen').then(({ StartupScreen }) => render(<StartupScreen bridge={startup} />))
} else {
  void import('./App').then(({ App }) => render(<App />))
}
