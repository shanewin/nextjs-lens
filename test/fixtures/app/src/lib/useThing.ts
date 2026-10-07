import { useState } from 'react'
// Hook definition: calling useState here is fine, since only the caller's environment matters
export function useThing() { const [x] = useState(0); return x }
