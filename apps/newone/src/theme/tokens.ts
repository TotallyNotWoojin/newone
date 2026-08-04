import { Platform } from 'react-native';

export const colors = {
  ink: '#13211D',
  inkMuted: '#53635D',
  inkSubtle: '#5F6F69',
  canvas: '#F3F5F1',
  paper: '#FFFFFF',
  paperMuted: '#F7F8F5',
  line: '#E2E7E2',
  lineStrong: '#D4DCD5',
  forest: '#102E27',
  forestRaised: '#173D34',
  mint: '#35C48D',
  mintDark: '#167854',
  mintSoft: '#DDF7EC',
  blue: '#2A61C9',
  blueSoft: '#EAF1FF',
  amber: '#874A08',
  amberSoft: '#FFF0D8',
  red: '#A6382F',
  redSoft: '#FDEAE7',
  plum: '#68439A',
  plumSoft: '#F0E9FA',
  white: '#FFFFFF',
  black: '#08110E',
  overlay: 'rgba(10, 27, 22, 0.46)',
} as const;

export const spacing = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  xxxl: 40,
} as const;

export const radii = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  pill: 999,
} as const;

export const type = {
  display: Platform.select({ ios: 'Avenir Next', default: 'sans-serif' }),
  body: Platform.select({ ios: 'System', default: 'sans-serif' }),
  mono: Platform.select({ ios: 'Menlo', default: 'monospace' }),
} as const;

export const shadow = Platform.select({
  web: {
    boxShadow: '0 12px 36px rgba(25, 52, 43, 0.08)',
  },
  default: {
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 20,
    elevation: 5,
  },
});
