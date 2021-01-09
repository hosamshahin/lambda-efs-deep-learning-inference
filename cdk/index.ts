// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import cdk = require('@aws-cdk/core');
import ec2 = require('@aws-cdk/aws-ec2');
import iam = require('@aws-cdk/aws-iam');
import efs = require('@aws-cdk/aws-efs');
import codebuild = require('@aws-cdk/aws-codebuild');
import cr = require('@aws-cdk/custom-resources');
import lambda = require('@aws-cdk/aws-lambda');
import path = require('path');
import { Arn, Size, RemovalPolicy } from '@aws-cdk/core';

interface LambdaEFSMLStackProps extends cdk.StackProps {
  readonly installPackages?: string;
}

export class LambdaEFSMLStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: LambdaEFSMLStackProps) {
    super(scope, id, props);

    // VPC definition.
    const vpc = new ec2.Vpc(this, 'LambdaEFSMLVPC', {
      maxAzs: 2,
      natGateways: 1,
    });

    // Security Group definitions.
    const ec2SecurityGroup = new ec2.SecurityGroup(this, 'LambdaEFSMLEC2SG', {
      vpc,
      securityGroupName: "LambdaEFSMLEC2SG",
    });

    const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaEFSMLLambdaSG', {
      vpc,
      securityGroupName: "LambdaEFSMLLambdaSG",
    });

    const efsSecurityGroup = new ec2.SecurityGroup(this, 'LambdaEFSMLEFSSG', {
      vpc,
      securityGroupName: "LambdaEFSMLEFSSG",
    });

    ec2SecurityGroup.connections.allowTo(efsSecurityGroup, ec2.Port.tcp(2049));
    lambdaSecurityGroup.connections.allowTo(efsSecurityGroup, ec2.Port.tcp(2049));

    // Elastic File System file system.
    // For the purpose of cost saving, provisioned troughput has been kept low.
    const fs = new efs.FileSystem(this, 'LambdaEFSMLEFS', {
      vpc: vpc,
      securityGroup: efsSecurityGroup,
      throughputMode: efs.ThroughputMode.PROVISIONED,
      provisionedThroughputPerSecond: Size.mebibytes(10),
      removalPolicy: RemovalPolicy.DESTROY
    });

    const EfsAccessPoint = new efs.AccessPoint(this, 'EfsAccessPoint', {
      fileSystem: fs,
      path: '/lambda',
      posixUser: {
        gid: '1000',
        uid: '1000'
      },
      createAcl: {
        ownerGid: '1000',
        ownerUid: '1000',
        permissions: '777'
      }
    })

    // Lambda function to execute inference.
    const executeInferenceFunction = new lambda.Function(this, 'LambdaEFSMLExecuteInference', {
      runtime: lambda.Runtime.PYTHON_3_8,
      handler: 'main.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda')),
      vpc,
      vpcSubnets: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE }),
      securityGroup: lambdaSecurityGroup,
      timeout: cdk.Duration.minutes(2),
      memorySize: 3008,
      reservedConcurrentExecutions: 10,
      filesystem: lambda.FileSystem.fromEfsAccessPoint(EfsAccessPoint, '/mnt/python')
    });
    executeInferenceFunction.role?.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonElasticFileSystemClientFullAccess"));

    // Leveraging on AWS CodeBuild to install Python libraries to EFS.
    const codeBuildProject = new codebuild.Project(this, 'LambdaEFSMLCodeBuildProject', {
      projectName: "LambdaEFSMLCodeBuildProject",
      description: "Installs Python libraries to EFS.",
      vpc,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.1',
        phases: {
          build: {
            commands: [
              'echo "Clone covid_xrays repo"',
              'rm -rf $CODEBUILD_EFS1/lambda/covid_xrays',
              'mkdir -p $CODEBUILD_EFS1/lambda/covid_xrays',
              'git clone https://github.com/doaa-altarawy/covid_xrays.git $CODEBUILD_EFS1/lambda/covid_xrays',
              'echo "Create Conda env"',
              'conda create -p $CODEBUILD_EFS1/lambda/covid_xrays/covid_xrays_model/xrays python=3.8 pip',
              'echo "conda init --all --dry-run --verbose"',
              'conda init --all --dry-run --verbose',
              'echo "conda run -p $CODEBUILD_EFS1/lambda/covid_xrays/covid_xrays_model/xrays pip install -r $CODEBUILD_EFS1/lambda/covid_xrays/covid_xrays_model/requirements.txt"',
              'conda run -p $CODEBUILD_EFS1/lambda/covid_xrays/covid_xrays_model/xrays pip install -r $CODEBUILD_EFS1/lambda/covid_xrays/covid_xrays_model/requirements.txt',
              'echo "conda run -p $CODEBUILD_EFS1/lambda/covid_xrays/covid_xrays_model/xrays pip install -e $CODEBUILD_EFS1/lambda/covid_xrays/covid_xrays_model/."',
              'conda run -p $CODEBUILD_EFS1/lambda/covid_xrays/covid_xrays_model/xrays pip install -e $CODEBUILD_EFS1/lambda/covid_xrays/covid_xrays_model/.',
              'echo "Changing folder permissions..."',
              'chown -R 1000:1000 $CODEBUILD_EFS1/lambda/'
            ]
          }
        },
      }),

      environment: {
        buildImage: codebuild.LinuxBuildImage.fromDockerRegistry('continuumio/anaconda3:latest'),
        computeType: codebuild.ComputeType.LARGE,
        privileged: true,
      },
      securityGroups: [ec2SecurityGroup],
      subnetSelection: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE }),
      timeout: cdk.Duration.minutes(30),
    });

    // Configure EFS for CodeBuild.
    const cfnProject = codeBuildProject.node.defaultChild as codebuild.CfnProject;
    cfnProject.fileSystemLocations = [{
      type: "EFS",
      //location: fs.mountTargetsAvailable + ".efs." + cdk.Stack.of(this).region + ".amazonaws.com:/",
      location: fs.fileSystemId + ".efs." + cdk.Stack.of(this).region + ".amazonaws.com:/",
      mountPoint: "/mnt/python",
      identifier: "efs1",
      mountOptions: "nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2"
    }]
    cfnProject.logsConfig = {
      cloudWatchLogs: {
        status: "ENABLED"
      }
    }

    // Triggers the CodeBuild project to install the python packages and model to the EFS file system
    const triggerBuildProject = new cr.AwsCustomResource(this, 'TriggerCodeBuild', {
      onCreate: {
        service: 'CodeBuild',
        action: 'startBuild',
        parameters: {
          projectName: codeBuildProject.projectName
        },
        physicalResourceId: cr.PhysicalResourceId.fromResponse('build.id'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE })
    });

    // Create dependenct between EFS and Codebuild
    codeBuildProject.node.addDependency(EfsAccessPoint);

    // Output Lambda function name.
    new cdk.CfnOutput(this, 'LambdaFunctionName', { value: executeInferenceFunction.functionName });
  }
}

const app = new cdk.App();

var props: LambdaEFSMLStackProps = {
  installPackages: undefined,
  env: {
    region: 'us-east-1'
  }
}

new LambdaEFSMLStack(app, 'LambdaEFSMLDemo', props);
app.synth();
