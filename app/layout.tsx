import type{Metadata}from'next';
import'./globals.css';
export const metadata:Metadata={title:'Faultline — Resilience Lab',description:'Rehearse failure before it finds you. A deterministic, local-first distributed systems simulator for developers.',icons:{icon:'/favicon.svg',shortcut:'/favicon.svg'}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en" className="dark"><body>{children}</body></html>;}
