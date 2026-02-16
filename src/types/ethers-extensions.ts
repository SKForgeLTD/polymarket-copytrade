/**
 * Type definitions for ethers.js contract interactions
 */

import type { BigNumber, BigNumberish, ContractTransaction } from 'ethers';

/**
 * ERC20 token contract interface
 */
export interface IERC20 {
  balanceOf(owner: string): Promise<BigNumber>;
  transfer(to: string, amount: BigNumberish): Promise<ContractTransaction>;
  allowance(owner: string, spender: string): Promise<BigNumber>;
  approve(spender: string, amount: BigNumberish): Promise<ContractTransaction>;
  totalSupply(): Promise<BigNumber>;
  decimals(): Promise<BigNumber>;
  symbol(): Promise<string>;
  name(): Promise<string>;
}

/**
 * USDC contract address on Polygon
 */
export const USDC_POLYGON_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

/**
 * USDC token decimals
 */
export const USDC_DECIMALS = 6;

/**
 * Standard ERC20 ABI fragments for balance queries
 */
export const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
] as const;
