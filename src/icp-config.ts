export interface ICPCriteria {
  targetIndustries: string[];
  positiveKeywords: string[];
  negativeKeywords: string[];
  weights: {
    adActivity: number;
    adSpendLevel: number;
    industryFit: number;
    hasEcommerce: number;
    websiteQuality: number;
  };
}

export const ICP_CONFIG: ICPCriteria = {
  targetIndustries: [
    'e-commerce',
    'direct-to-consumer',
    'dtc',
    'retail',
    'fashion',
    'apparel',
    'beauty',
    'skincare',
    'health & wellness',
    'supplements',
    'fitness',
    'food & beverage',
    'home goods',
    'pet products',
    'jewelry',
    'accessories',
    'saas',
    'software',
    'mobile apps',
    'education technology',
    'financial services',
    'insurance',
    'real estate',
    'marketing agency',
    'media buying',
    'performance marketing',
  ],
  positiveKeywords: [
    'shop now',
    'buy now',
    'add to cart',
    'free shipping',
    'sale',
    'discount',
    'subscribe',
    'free trial',
    'get started',
    'pricing',
    'plans',
    'checkout',
    'order now',
    'limited time',
    'best seller',
    'new arrivals',
    'collection',
    'bundle',
    'results',
    'guarantee',
  ],
  negativeKeywords: [
    'non-profit',
    'nonprofit',
    'charity',
    'donate',
    'government',
    'municipality',
    'public school',
    '.gov',
    '.edu',
  ],
  weights: {
    adActivity: 35,
    adSpendLevel: 25,
    industryFit: 20,
    hasEcommerce: 10,
    websiteQuality: 10,
  },
};

export const EMAIL_TEMPLATES = {
  runningAds: (vars: {
    firstName: string;
    company: string;
    adInsight: string;
    angle: string;
    sampleAdNote: string;
  }) => `Hi ${vars.firstName},

Noticed ${vars.company} is running ads — ${vars.adInsight}

${vars.angle}

${vars.sampleAdNote}

Worth a quick chat?

Brian`,

  noAds: (vars: {
    firstName: string;
    company: string;
    positioning: string;
    opportunity: string;
  }) => `Hi ${vars.firstName},

Checked out ${vars.company} — ${vars.positioning}

${vars.opportunity}

Open to a quick 15 min?

Brian`,
};
