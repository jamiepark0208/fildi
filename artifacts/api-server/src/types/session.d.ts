// export {} makes this a module so declare module augments instead of replacing
export {}

declare module 'express-session' {
  interface SessionData {
    userId: number
    role: 'admin' | 'member'
  }
}
