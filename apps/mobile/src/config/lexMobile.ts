import Constants from 'expo-constants';
import product from '../../../../config/lex-product.json';

export const IS_LEX_MOBILE = Constants.expoConfig?.slug === 'lex-mobile';
export const LEX_ANDROID_PACKAGE = 'io.github.ciciyl.lex';
export const LEX_PRODUCT = product;
