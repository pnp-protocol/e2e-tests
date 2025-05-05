const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PNPFactory", function () {
  let pnpFactory;
  let mockERC20;
  let pythagoreanBondingCurve;
  let owner;
  let user1;
  let user2;

  // Constants for market creation
  const MARKET_QUESTION = "Will ETH be above $4000 by end of 2024?";
  const MARKET_QUESTION_2 = "Will [X] get [z] inside [y]  by 2025?";
  const MARKET_QUESTION_3 = "";

  
  const INITIAL_LIQUIDITY = ethers.parseUnits("10000", 6); // 10k USDC (6 decimals)
  
  // unix timestamp for December 31, 2025 (way in the future)
  const FUTURE_TIMESTAMP = 1798761600;
  
  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();
    
    // Deploy MockERC20 with 6 decimals (like USDC)
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockERC20 = await MockERC20.deploy("USD Coin", "USDC", 6);
    
    // deploy the PythagoreanBondingCurve library
    const PythagoreanBondingCurve = await ethers.getContractFactory("PythagoreanBondingCurve");
    pythagoreanBondingCurve = await PythagoreanBondingCurve.deploy();
    
    // Deploy PNPFactory with the library link
    const PNPFactory = await ethers.getContractFactory("PNPFactory", {
      libraries: {
        PythagoreanBondingCurve: pythagoreanBondingCurve.target
      }
    });
  
    pnpFactory = await PNPFactory.deploy("https://api.pnp-protocol.io/metadata/");
    
    // Mint tokens to users
    await mockERC20.mint(user1.address, ethers.parseUnits("100000", 6));
    await mockERC20.mint(user2.address, ethers.parseUnits("100000", 6));
    
    // Users approve PNPFactory to spend their tokens
    await mockERC20.connect(user1).approve(pnpFactory.target, ethers.MaxUint256);
    await mockERC20.connect(user2).approve(pnpFactory.target, ethers.MaxUint256);
  });

  describe("Market Creation", function () {
     it("Should create a prediction market successfully", async function () {
      // Create a prediction market with fixed future timestamp
      const tx = await pnpFactory.connect(user1).createPredictionMarket(
        INITIAL_LIQUIDITY,
        mockERC20.target,
        MARKET_QUESTION,
        FUTURE_TIMESTAMP
      );
      
      // Get the market ID (conditionId) from the event
      const receipt = await tx.wait();
      const event = receipt.logs.find(log => 
        pnpFactory.interface.parseLog(log)?.name === "PNP_MarketCreated"
      );
      const parsedEvent = pnpFactory.interface.parseLog(event);
      const conditionId = parsedEvent.args.conditionId;
      
      // Verify market was created correctly
      expect(await pnpFactory.isMarketCreated(conditionId)).to.be.true;
      expect(await pnpFactory.marketQuestion(conditionId)).to.equal(MARKET_QUESTION);
      expect(await pnpFactory.marketEndTime(conditionId)).to.equal(FUTURE_TIMESTAMP);
      expect(await pnpFactory.collateralToken(conditionId)).to.equal(mockERC20.target);
      
      // Verify the creator received YES and NO tokens
      const yesTokenId = await pnpFactory.getYesTokenId(conditionId);
      const noTokenId = await pnpFactory.getNoTokenId(conditionId);
      
      // The tokens are converted to 18 decimals internally
      const expectedBalance = INITIAL_LIQUIDITY * BigInt(10 ** 12);
      
      expect(await pnpFactory.balanceOf(user1.address, yesTokenId)).to.equal(expectedBalance);
      expect(await pnpFactory.balanceOf(user1.address, noTokenId)).to.equal(expectedBalance);
    });
    
    it("Should revert when creating a market with invalid end time", async function () {
      const pastEndTime = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
      
      await expect(
        pnpFactory.connect(user1).createPredictionMarket(
          INITIAL_LIQUIDITY,
          mockERC20.target,
          MARKET_QUESTION,
          pastEndTime
        )
      ).to.be.revertedWithCustomError(pnpFactory, "InvalidMarketEndTime");
    });

    it("Should revert when initialLiquidity is zero", async function () {
      //  create a prediction market with zero initial liquidity
      await expect(
        pnpFactory.connect(user1).createPredictionMarket(
          0, 
          mockERC20.target,
          MARKET_QUESTION,
          FUTURE_TIMESTAMP
        )
      ).to.be.revertedWith("Invalid liquidity wtf");
    });
    
    it("Should revert when collateral token is address zero", async function () {
      // create a prediction market with address zero as collateral
      await expect(
        pnpFactory.connect(user1).createPredictionMarket(
          INITIAL_LIQUIDITY,
          ethers.ZeroAddress, // Zero address
          MARKET_QUESTION,
          FUTURE_TIMESTAMP
        )
      ).to.be.revertedWith("Collateral must not be zero address");
    });
  });

  describe("Decision Token Operations", function () {
    let conditionId;
    let yesTokenId;
    let noTokenId;
    
    beforeEach(async function () {
      // Create a prediction market with fixed future timestamp
      const tx = await pnpFactory.connect(user1).createPredictionMarket(
        INITIAL_LIQUIDITY,
        mockERC20.target,
        MARKET_QUESTION,
        FUTURE_TIMESTAMP
      );
      
      // Get the market ID (conditionId) from the event
      const receipt = await tx.wait();
      const event = receipt.logs.find(log => 
        pnpFactory.interface.parseLog(log)?.name === "PNP_MarketCreated"
      );
      const parsedEvent = pnpFactory.interface.parseLog(event);
      conditionId = parsedEvent.args.conditionId;
      
      // Get token IDs
      yesTokenId = await pnpFactory.getYesTokenId(conditionId);
      noTokenId = await pnpFactory.getNoTokenId(conditionId);
    });
    
    it("Should mint decision tokens correctly", async function () {
      const mintAmount = ethers.parseUnits("1000", 6); // 1000 USDC
      
      // User2 mints YES tokens
      await pnpFactory.connect(user2).mintDecisionTokens(conditionId, mintAmount, yesTokenId);
      
      // Check user2 balance of YES tokens increased
      const balance = await pnpFactory.balanceOf(user2.address, yesTokenId);
      expect(balance).to.be.gt(0);
      
      // Check that USDC was transferred from user2
      const factoryBalance = await mockERC20.balanceOf(pnpFactory.target);
      expect(factoryBalance).to.equal(INITIAL_LIQUIDITY + mintAmount);
    });
    
    it("Should burn decision tokens correctly", async function () {
      const mintAmount = ethers.parseUnits("1000", 6); // 1000 USDC
      
      // User2 mints YES tokens
      await pnpFactory.connect(user2).mintDecisionTokens(conditionId, mintAmount, yesTokenId);
      
      // Get user2's balance of YES tokens
      const initialYesBalance = await pnpFactory.balanceOf(user2.address, yesTokenId);
      const initialUsdcBalance = await mockERC20.balanceOf(user2.address);
      
      // User2 burns half their YES tokens
      const burnAmount = initialYesBalance / BigInt(2);
      await pnpFactory.connect(user2).burnDecisionTokens(conditionId, yesTokenId, burnAmount);
      
      // Check that YES tokens were burned
      const finalYesBalance = await pnpFactory.balanceOf(user2.address, yesTokenId);
      expect(finalYesBalance).to.equal(initialYesBalance - burnAmount);
      
      // Check that USDC was returned to user2
      const finalUsdcBalance = await mockERC20.balanceOf(user2.address);
      expect(finalUsdcBalance).to.be.gt(initialUsdcBalance);
    });
  });
});