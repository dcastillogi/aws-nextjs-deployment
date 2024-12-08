#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AppStack } from '../lib/app-stack';
import * as dotenv from 'dotenv';
import { ArtifactStack } from '../lib/artifact-stack';

// Load environment variables from .env file in the cdk folder
dotenv.config({ path: process.cwd() + '/.env' });

const app = new cdk.App();
new AppStack(app, 'AppStack');
new ArtifactStack(app, 'ArtifactStack');