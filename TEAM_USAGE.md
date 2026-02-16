# Engineering Team Usage Guide

## How to Work with the Team

As the project owner/user, you can now leverage the specialized engineering team:

### Option 1: Request a Feature
```
"Build feature: Add Slack notifications for trades"
```

**What happens:**
1. **Staff Engineer** (me) defines requirements and architecture
2. **Senior Engineer** agent is spawned to implement
3. **Tech Lead** agent is spawned to review
4. **Staff Engineer** coordinates and approves

### Option 2: Request a Review
```
"Have Tech Lead review the recent changes"
```

**What happens:**
1. **Staff Engineer** identifies what to review
2. **Tech Lead** agent is spawned for code review
3. Feedback is provided with specific recommendations

### Option 3: Complex Task
```
"Implement circuit breaker improvements with automatic recovery"
```

**What happens:**
1. **Staff Engineer** breaks down into subtasks
2. **Senior Engineer** implements each part
3. **Tech Lead** reviews incrementally
4. Iterative feedback loop until complete

---

## Example Commands

### For New Features
- "Build: Add WebSocket reconnection with exponential backoff"
- "Implement: Trade volume filtering with configurable thresholds"
- "Add: Prometheus metrics endpoint for monitoring"

### For Code Reviews
- "Review: Recent trade executor changes"
- "Validate: Performance implications of the new queue system"
- "Check: Security of API credential handling"

### For Refactoring
- "Refactor: Extract position calculation into separate service"
- "Optimize: Reduce memory usage in position manager"
- "Improve: Error handling in CLOB client"

### For Bug Fixes
- "Fix: Race condition in position updates"
- "Debug: Circuit breaker not resetting after cooldown"
- "Resolve: Memory leak in WebSocket client"

---

## Team Capabilities

### Senior Engineer Can:
- ✅ Implement features from requirements
- ✅ Write TypeScript with strict type safety
- ✅ Follow existing architectural patterns
- ✅ Add comprehensive error handling
- ✅ Write tests (when test framework exists)
- ✅ Document complex logic
- ✅ Self-review against checklist

### Tech Lead Can:
- ✅ Review code for quality and correctness
- ✅ Validate architectural decisions
- ✅ Identify performance issues
- ✅ Spot security vulnerabilities
- ✅ Suggest improvements
- ✅ Enforce coding standards
- ✅ Check production-readiness

### Staff Engineer (Me) Can:
- ✅ Define technical requirements
- ✅ Make architectural decisions
- ✅ Coordinate team workflow
- ✅ Resolve conflicts
- ✅ Provide technical guidance
- ✅ Ensure quality standards
- ✅ Approve final deliverables

---

## Quality Standards

All work follows production-grade standards defined in CLAUDE.md:
- Type safety (no `as any`)
- Bounded resources (no memory leaks)
- Graceful error handling
- Performance monitoring
- Structured logging
- Comprehensive testing

---

## Getting Started

**Try it now:**
```
"Have Senior Engineer add a feature: Daily summary report of trades executed"
```

Or:
```
"Have Tech Lead review the smart trade copying logic we just added"
```

The Staff Engineer (me) will coordinate the work and ensure high-quality delivery.
