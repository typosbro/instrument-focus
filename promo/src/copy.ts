// Headline markup: *word* is highlighted in the segment's accent colour.
type Copy = {
  head: Record<string, string>;
  sub: Record<string, string>;
  stems: string[];
  cta: { title: string; stores: string; ask: string };
};

export const COPY: Record<'en' | 'uz', Copy> = {
  en: {
    head: {
      hook: 'this song…',
      vocals: '…but *ONLY* the vocals',
      drums: '*ONLY* the drums',
      bass: '*ONLY* the bass 🎧',
      mix: 'or mix *your own*',
      reveal: '*1 click.* any YouTube song.',
      end: 'free browser extension',
    },
    sub: {
      hook: 'sound on 🔊',
      reveal: 'runs on your own GPU · nothing uploaded',
    },
    stems: ['Drums', 'Bass', 'Other', 'Vocals', 'Guitar', 'Piano'],
    cta: { title: 'Chrome + Firefox', stores: 'link in bio', ask: 'which song next? 👇' },
  },
  uz: {
    head: {
      hook: 'bu qoʻshiq…',
      vocals: '…lekin *FAQAT* ovoz',
      drums: '*FAQAT* baraban',
      bass: '*FAQAT* bas 🎧',
      mix: 'yoki *oʻzingiz* aralashtiring',
      reveal: '*1 klik.* istalgan YouTube qoʻshigʻi.',
      end: 'bepul brauzer kengaytmasi',
    },
    sub: {
      hook: 'ovozni yoqing 🔊',
      reveal: 'oʻz GPUʼingizda ishlaydi · hech narsa yuklanmaydi',
    },
    stems: ['Baraban', 'Bas', 'Boshqa', 'Ovoz', 'Gitara', 'Pianino'],
    cta: { title: 'Chrome + Firefox', stores: 'havola bioda', ask: 'keyingi qaysi qoʻshiq? 👇' },
  },
};
