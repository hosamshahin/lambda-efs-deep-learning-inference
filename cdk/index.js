"use strict";
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
Object.defineProperty(exports, "__esModule", { value: true });
const cdk = require("@aws-cdk/core");
const ec2 = require("@aws-cdk/aws-ec2");
const iam = require("@aws-cdk/aws-iam");
const efs = require("@aws-cdk/aws-efs");
const codebuild = require("@aws-cdk/aws-codebuild");
const cr = require("@aws-cdk/custom-resources");
const lambda = require("@aws-cdk/aws-lambda");
const path = require("path");
const core_1 = require("@aws-cdk/core");
class LambdaEFSMLStack extends cdk.Stack {
    constructor(scope, id, props) {
        var _a;
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
            provisionedThroughputPerSecond: core_1.Size.mebibytes(10),
            removalPolicy: core_1.RemovalPolicy.DESTROY
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
        });
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
        (_a = executeInferenceFunction.role) === null || _a === void 0 ? void 0 : _a.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonElasticFileSystemClientFullAccess"));
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
                            'echo "Downloading and copying model..."',
                            'mkdir -p $CODEBUILD_EFS1/lambda/model',
                            'curl https://storage.googleapis.com/tfhub-modules/google/openimages_v4/ssd/mobilenet_v2/1.tar.gz --output /tmp/1.tar.gz',
                            'tar zxf /tmp/1.tar.gz -C $CODEBUILD_EFS1/lambda/model',
                            'echo "Installing virtual environment..."',
                            'mkdir -p $CODEBUILD_EFS1/lambda',
                            'python3 -m venv $CODEBUILD_EFS1/lambda/tensorflow',
                            'echo "Installing Tensorflow..."',
                            'source $CODEBUILD_EFS1/lambda/tensorflow/bin/activate && pip3 install ' +
                                (props.installPackages ? props.installPackages : "tensorflow"),
                            'echo "Changing folder permissions..."',
                            'chown -R 1000:1000 $CODEBUILD_EFS1/lambda/'
                        ]
                    }
                },
            }),
            environment: {
                buildImage: codebuild.LinuxBuildImage.fromDockerRegistry('lambci/lambda:build-python3.8'),
                computeType: codebuild.ComputeType.LARGE,
                privileged: true,
            },
            securityGroups: [ec2SecurityGroup],
            subnetSelection: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE }),
            timeout: cdk.Duration.minutes(30),
        });
        // Configure EFS for CodeBuild.
        const cfnProject = codeBuildProject.node.defaultChild;
        cfnProject.fileSystemLocations = [{
                type: "EFS",
                //location: fs.mountTargetsAvailable + ".efs." + cdk.Stack.of(this).region + ".amazonaws.com:/",
                location: fs.fileSystemId + ".efs." + cdk.Stack.of(this).region + ".amazonaws.com:/",
                mountPoint: "/mnt/python",
                identifier: "efs1",
                mountOptions: "nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2"
            }];
        cfnProject.logsConfig = {
            cloudWatchLogs: {
                status: "ENABLED"
            }
        };
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
exports.LambdaEFSMLStack = LambdaEFSMLStack;
const app = new cdk.App();
var props = {
    installPackages: undefined,
    env: {
        region: 'us-east-1'
    }
};
new LambdaEFSMLStack(app, 'LambdaEFSMLDemo', props);
app.synth();
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUEscUVBQXFFO0FBQ3JFLGlDQUFpQzs7QUFFakMscUNBQXNDO0FBQ3RDLHdDQUF5QztBQUN6Qyx3Q0FBeUM7QUFDekMsd0NBQXlDO0FBQ3pDLG9EQUFxRDtBQUNyRCxnREFBaUQ7QUFDakQsOENBQStDO0FBQy9DLDZCQUE4QjtBQUM5Qix3Q0FBeUQ7QUFNekQsTUFBYSxnQkFBaUIsU0FBUSxHQUFHLENBQUMsS0FBSztJQUM3QyxZQUFZLEtBQWMsRUFBRSxFQUFVLEVBQUUsS0FBNEI7O1FBQ2xFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLGtCQUFrQjtRQUNsQixNQUFNLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO1lBQzlDLE1BQU0sRUFBRSxDQUFDO1lBQ1QsV0FBVyxFQUFFLENBQUM7U0FDZixDQUFDLENBQUM7UUFFSCw4QkFBOEI7UUFDOUIsTUFBTSxnQkFBZ0IsR0FBRyxJQUFJLEdBQUcsQ0FBQyxhQUFhLENBQUMsSUFBSSxFQUFFLGtCQUFrQixFQUFFO1lBQ3ZFLEdBQUc7WUFDSCxpQkFBaUIsRUFBRSxrQkFBa0I7U0FDdEMsQ0FBQyxDQUFDO1FBRUgsTUFBTSxtQkFBbUIsR0FBRyxJQUFJLEdBQUcsQ0FBQyxhQUFhLENBQUMsSUFBSSxFQUFFLHFCQUFxQixFQUFFO1lBQzdFLEdBQUc7WUFDSCxpQkFBaUIsRUFBRSxxQkFBcUI7U0FDekMsQ0FBQyxDQUFDO1FBRUgsTUFBTSxnQkFBZ0IsR0FBRyxJQUFJLEdBQUcsQ0FBQyxhQUFhLENBQUMsSUFBSSxFQUFFLGtCQUFrQixFQUFFO1lBQ3ZFLEdBQUc7WUFDSCxpQkFBaUIsRUFBRSxrQkFBa0I7U0FDdEMsQ0FBQyxDQUFDO1FBRUgsZ0JBQWdCLENBQUMsV0FBVyxDQUFD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RUFBRTtZQUM3RSxRQUFRLEVBQUU7Z0JBQ1IsT0FBTyxFQUFFLFdBQVc7Z0JBQ3BCLE1BQU0sRUFBRSxZQUFZO2dCQUNwQixVQUFVLEVBQUU7b0JBQ1YsV0FBVyxFQUFFLGdCQUFnQixDQUFDLFdBQVc7aUJBQzFDO2dCQUNELGtCQUFrQixFQUFFLEVBQUUsQ0FBQyxrQkFBa0IsQ0FBQyxZQUFZLENBQUMsVUFBVSxDQUFDO2FBQ25FO1lBQ0QsTUFBTSxFQUFFLEVBQUUsQ0FBQyx1QkFBdUIsQ0FBQyxZQUFZLENBQUMsRUFBRSxTQUFTLEVBQUUsRUFBRSxDQUFDLHVCQUF1QixDQUFDLFlBQVksRUFBRSxDQUFDO1NBQ3hHLENBQUMsQ0FBQztRQUVILDhDQUE4QztRQUM5QyxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLGNBQWMsQ0FBQyxDQUFDO1FBRXBELCtCQUErQjtRQUMvQixJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLG9CQUFvQixFQUFFLEVBQUUsS0FBSyxFQUFFLHdCQUF3QixDQUFDLFlBQVksRUFBRSxDQUFDLENBQUM7SUFDbEcsQ0FBQztDQUNGO0FBNUlELDRDQTRJQztBQUVELE1BQU0sR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO0FBRTFCLElBQUksS0FBSyxHQUEwQjtJQUNqQyxlQUFlLEVBQUUsU0FBUztJQUMxQixHQUFHLEVBQUU7UUFDSCxNQUFNLEVBQUUsV0FBVztLQUNwQjtDQUNGLENBQUE7QUFFRCxJQUFJLGdCQUFnQixDQUFDLEdBQUcsRUFBRSxpQkFBaUIsRUFBRSxLQUFLLENBQUMsQ0FBQztBQUNwRCxHQUFHLENBQUMsS0FBSyxFQUFFLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgQW1hem9uLmNvbSwgSW5jLiBvciBpdHMgYWZmaWxpYXRlcy4gQWxsIFJpZ2h0cyBSZXNlcnZlZC5cbi8vIFNQRFgtTGljZW5zZS1JZGVudGlmaWVyOiBNSVQtMFxuXG5pbXBvcnQgY2RrID0gcmVxdWlyZSgnQGF3cy1jZGsvY29yZScpO1xuaW1wb3J0IGVjMiA9IHJlcXVpcmUoJ0Bhd3MtY2RrL2F3cy1lYzInKTtcbmltcG9ydCBpYW0gPSByZXF1aXJlKCdAYXdzLWNkay9hd3MtaWFtJyk7XG5pbXBvcnQgZWZzID0gcmVxdWlyZSgnQGF3cy1jZGsvYXdzLWVmcycpO1xuaW1wb3J0IGNvZGVidWlsZCA9IHJlcXVpcmUoJ0Bhd3MtY2RrL2F3cy1jb2RlYnVpbGQnKTtcbmltcG9ydCBjciA9IHJlcXVpcmUoJ0Bhd3MtY2RrL2N1c3RvbS1yZXNvdXJjZXMnKTtcbmltcG9ydCBsYW1iZGEgPSByZXF1aXJlKCdAYXdzLWNkay9hd3MtbGFtYmRhJyk7XG5pbXBvcnQgcGF0aCA9IHJlcXVpcmUoJ3BhdGgnKTtcbmltcG9ydCB7IEFybiwgU2l6ZSwgUmVtb3ZhbFBvbGljeSB9IGZyb20gJ0Bhd3MtY2RrL2NvcmUnO1xuXG5pbnRlcmZhY2UgTGFtYmRhRUZTTUxTdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICByZWFkb25seSBpbnN0YWxsUGFja2FnZXM/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBMYW1iZGFFRlNNTFN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IGNkay5BcHAsIGlkOiBzdHJpbmcsIHByb3BzOiBMYW1iZGFFRlNNTFN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vIFZQQyBkZWZpbml0aW9uLlxuICAgIGNvbnN0IHZwYyA9IG5ldyBlYzIuVnBjKHRoaXMsICdMYW1iZGFFRlNNTFZQQycsIHtcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgIH0pO1xuXG4gICAgLy8gU2VjdXJpdHkgR3JvdXAgZGVmaW5pdGlvbnMuXG4gICAgY29uc3QgZWMyU2VjdXJpdHlHcm91cCA9IG5ldyBlYzIuU2VjdXJpdHlHcm91cCh0aGlzLCAnTGFtYmRhRUZTTUxFQzJTRycsIHtcbiAgICAgIHZwYyxcbiAgICAgIHNlY3VyaXR5R3JvdXBOYW1lOiBcIkxhbWJkYUVGU01MRUMyU0dcIixcbiAgICB9KTtcblxuICAgIGNvbnN0IGxhbWJkYVNlY3VyaXR5R3JvdXAgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgJ0xhbWJkYUVGU01MTGFtYmRhU0cnLCB7XG4gICAgICB2cGMsXG4gICAgICBzZWN1cml0eUdyb3VwTmFtZTogXCJMYW1iZGFFRlNNTExhbWJkYVNHXCIsXG4gICAgfSk7XG5cbiAgICBjb25zdCBlZnNTZWN1cml0eUdyb3VwID0gbmV3IGVjMi5TZWN1cml0eUdyb3VwKHRoaXMsICdMYW1iZGFFRlNNTEVGU1NHJywge1xuICAgICAgdnBjLFxuICAgICAgc2VjdXJpdHlHcm91cE5hbWU6IFwiTGFtYmRhRUZTTUxFRlNTR1wiLFxuICAgIH0pO1xuXG4gICAgZWMyU2VjdXJpdHlHcm91cC5jb25uZWN0aW9ucy5hbGxvd1RvKGVmc1NlY3VyaXR5R3JvdXAsIGVjMi5Qb3J0LnRjcCgyMDQ5KSk7XG4gICAgbGFtYmRhU2VjdXJpdHlHcm91cC5jb25uZWN0aW9ucy5hbGxvd1RvKGVmc1NlY3VyaXR5R3JvdXAsIGVjMi5Qb3J0LnRjcCgyMDQ5KSk7XG5cbiAgICAvLyBFbGFzdGljIEZpbGUgU3lzdGVtIGZpbGUgc3lzdGVtLlxuICAgIC8vIEZvciB0aGUgcHVycG9zZSBvZiBjb3N0IHNhdmluZywgcHJvdmlzaW9uZWQgdHJvdWdocHV0IGhhcyBiZWVuIGtlcHQgbG93LlxuICAgIGNvbnN0IGZzID0gbmV3IGVmcy5GaWxlU3lzdGVtKHRoaXMsICdMYW1iZGFFRlNNTEVGUycsIHtcbiAgICAgIHZwYzogdnBjLFxuICAgICAgc2VjdXJpdHlHcm91cDogZWZzU2VjdXJpdHlHcm91cCxcbiAgICAgIHRocm91Z2hwdXRNb2RlOiBlZnMuVGhyb3VnaHB1dE1vZGUuUFJPVklTSU9ORUQsXG4gICAgICBwcm92aXNpb25lZFRocm91Z2hwdXRQZXJTZWNvbmQ6IFNpemUubWViaWJ5dGVzKDEwKSxcbiAgICAgIHJlbW92YWxQb2xpY3k6IFJlbW92YWxQb2xpY3kuREVTVFJPWVxuICAgIH0pO1xuXG4gICAgY29uc3QgRWZzQWNjZXNzUG9pbnQgPSBuZXcgZWZzLkFjY2Vzc1BvaW50KHRoaXMsICdFZnNBY2Nlc3NQb2ludCcsIHtcbiAgICAgIGZpbGVTeXN0ZW06IGZzLFxuICAgICAgcGF0aDogJy9sYW1iZGEnLFxuICAgICAgcG9zaXhVc2VyOiB7XG4gICAgICAgIGdpZDogJzEwMDAnLFxuICAgICAgICB1aWQ6ICcxMDAwJ1xuICAgICAgfSxcbiAgICAgIGNyZWF0ZUFjbDoge1xuICAgICAgICBvd25lckdpZDogJzEwMDAnLFxuICAgICAgICBvd25lclVpZDogJzEwMDAnLFxuICAgICAgICBwZXJtaXNzaW9uczogJzc3NydcbiAgICAgIH1cbiAgICB9KVxuXG4gICAgLy8gTGFtYmRhIGZ1bmN0aW9uIHRvIGV4ZWN1dGUgaW5mZXJlbmNlLlxuICAgIGNvbnN0IGV4ZWN1dGVJbmZlcmVuY2VGdW5jdGlvbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ0xhbWJkYUVGU01MRXhlY3V0ZUluZmVyZW5jZScsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzgsXG4gICAgICBoYW5kbGVyOiAnbWFpbi5sYW1iZGFfaGFuZGxlcicsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQocGF0aC5qb2luKF9fZGlybmFtZSwgJy4uJywgJ2xhbWJkYScpKSxcbiAgICAgIHZwYyxcbiAgICAgIHZwY1N1Ym5ldHM6IHZwYy5zZWxlY3RTdWJuZXRzKHsgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURSB9KSxcbiAgICAgIHNlY3VyaXR5R3JvdXA6IGxhbWJkYVNlY3VyaXR5R3JvdXAsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24ubWludXRlcygyKSxcbiAgICAgIG1lbW9yeVNpemU6IDMwMDgsXG4gICAgICByZXNlcnZlZENvbmN1cnJlbnRFeGVjdXRpb25zOiAxMCxcbiAgICAgIGZpbGVzeXN0ZW06IGxhbWJkYS5GaWxlU3lzdGVtLmZyb21FZnNBY2Nlc3NQb2ludChFZnNBY2Nlc3NQb2ludCwgJy9tbnQvcHl0aG9uJylcbiAgICB9KTtcbiAgICBleGVjdXRlSW5mZXJlbmNlRnVuY3Rpb24ucm9sZT8uYWRkTWFuYWdlZFBvbGljeShpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoXCJBbWF6b25FbGFzdGljRmlsZVN5c3RlbUNsaWVudEZ1bGxBY2Nlc3NcIikpO1xuXG4gICAgLy8gTGV2ZXJhZ2luZyBvbiBBV1MgQ29kZUJ1aWxkIHRvIGluc3RhbGwgUHl0aG9uIGxpYnJhcmllcyB0byBFRlMuXG4gICAgY29uc3QgY29kZUJ1aWxkUHJvamVjdCA9IG5ldyBjb2RlYnVpbGQuUHJvamVjdCh0aGlzLCAnTGFtYmRhRUZTTUxDb2RlQnVpbGRQcm9qZWN0Jywge1xuICAgICAgcHJvamVjdE5hbWU6IFwiTGFtYmRhRUZTTUxDb2RlQnVpbGRQcm9qZWN0XCIsXG4gICAgICBkZXNjcmlwdGlvbjogXCJJbnN0YWxscyBQeXRob24gbGlicmFyaWVzIHRvIEVGUy5cIixcbiAgICAgIHZwYyxcbiAgICAgIGJ1aWxkU3BlYzogY29kZWJ1aWxkLkJ1aWxkU3BlYy5mcm9tT2JqZWN0KHtcbiAgICAgICAgdmVyc2lvbjogJzAuMScsXG4gICAgICAgIHBoYXNlczoge1xuICAgICAgICAgIGJ1aWxkOiB7XG4gICAgICAgICAgICBjb21tYW5kczogW1xuICAgICAgICAgICAgICAnZWNobyBcIkRvd25sb2FkaW5nIGFuZCBjb3B5aW5nIG1vZGVsLi4uXCInLFxuICAgICAgICAgICAgICAnbWtkaXIgLXAgJENPREVCVUlMRF9FRlMxL2xhbWJkYS9tb2RlbCcsXG4gICAgICAgICAgICAgICdjdXJsIGh0dHBzOi8vc3RvcmFnZS5nb29nbGVhcGlzLmNvbS90Zmh1Yi1tb2R1bGVzL2dvb2dsZS9vcGVuaW1hZ2VzX3Y0L3NzZC9tb2JpbGVuZXRfdjIvMS50YXIuZ3ogLS1vdXRwdXQgL3RtcC8xLnRhci5neicsXG4gICAgICAgICAgICAgICd0YXIgenhmIC90bXAvMS50YXIuZ3ogLUMgJENPREVCVUlMRF9FRlMxL2xhbWJkYS9tb2RlbCcsXG4gICAgICAgICAgICAgICdlY2hvIFwiSW5zdGFsbGluZyB2aXJ0dWFsIGVudmlyb25tZW50Li4uXCInLFxuICAgICAgICAgICAgICAnbWtkaXIgLXAgJENPREVCVUlMRF9FRlMxL2xhbWJkYScsXG4gICAgICAgICAgICAgICdweXRob24zIC1tIHZlbnYgJENPREVCVUlMRF9FRlMxL2xhbWJkYS90ZW5zb3JmbG93JyxcbiAgICAgICAgICAgICAgJ2VjaG8gXCJJbnN0YWxsaW5nIFRlbnNvcmZsb3cuLi5cIicsXG4gICAgICAgICAgICAgICdzb3VyY2UgJENPREVCVUlMRF9FRlMxL2xhbWJkYS90ZW5zb3JmbG93L2Jpbi9hY3RpdmF0ZSAmJiBwaXAzIGluc3RhbGwgJyArXG4gICAgICAgICAgICAgIChwcm9wcy5pbnN0YWxsUGFja2FnZXMgPyBwcm9wcy5pbnN0YWxsUGFja2FnZXMgOiBcInRlbnNvcmZsb3dcIiksXG4gICAgICAgICAgICAgICdlY2hvIFwiQ2hhbmdpbmcgZm9sZGVyIHBlcm1pc3Npb25zLi4uXCInLFxuICAgICAgICAgICAgICAnY2hvd24gLVIgMTAwMDoxMDAwICRDT0RFQlVJTERfRUZTMS9sYW1iZGEvJ1xuICAgICAgICAgICAgXVxuICAgICAgICAgIH1cbiAgICAgICAgfSxcbiAgICAgIH0pLFxuXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBidWlsZEltYWdlOiBjb2RlYnVpbGQuTGludXhCdWlsZEltYWdlLmZyb21Eb2NrZXJSZWdpc3RyeSgnbGFtYmNpL2xhbWJkYTpidWlsZC1weXRob24zLjgnKSxcbiAgICAgICAgY29tcHV0ZVR5cGU6IGNvZGVidWlsZC5Db21wdXRlVHlwZS5MQVJHRSxcbiAgICAgICAgcHJpdmlsZWdlZDogdHJ1ZSxcbiAgICAgIH0sXG4gICAgICBzZWN1cml0eUdyb3VwczogW2VjMlNlY3VyaXR5R3JvdXBdLFxuICAgICAgc3VibmV0U2VsZWN0aW9uOiB2cGMuc2VsZWN0U3VibmV0cyh7IHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEUgfSksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24ubWludXRlcygzMCksXG4gICAgfSk7XG5cbiAgICAvLyBDb25maWd1cmUgRUZTIGZvciBDb2RlQnVpbGQuXG4gICAgY29uc3QgY2ZuUHJvamVjdCA9IGNvZGVCdWlsZFByb2plY3Qubm9kZS5kZWZhdWx0Q2hpbGQgYXMgY29kZWJ1aWxkLkNmblByb2plY3Q7XG4gICAgY2ZuUHJvamVjdC5maWxlU3lzdGVtTG9jYXRpb25zID0gW3tcbiAgICAgIHR5cGU6IFwiRUZTXCIsXG4gICAgICAvL2xvY2F0aW9uOiBmcy5tb3VudFRhcmdldHNBdmFpbGFibGUgKyBcIi5lZnMuXCIgKyBjZGsuU3RhY2sub2YodGhpcykucmVnaW9uICsgXCIuYW1hem9uYXdzLmNvbTovXCIsXG4gICAgICBsb2NhdGlvbjogZnMuZmlsZVN5c3RlbUlkICsgXCIuZWZzLlwiICsgY2RrLlN0YWNrLm9mKHRoaXMpLnJlZ2lvbiArIFwiLmFtYXpvbmF3cy5jb206L1wiLFxuICAgICAgbW91bnRQb2ludDogXCIvbW50L3B5dGhvblwiLFxuICAgICAgaWRlbnRpZmllcjogXCJlZnMxXCIsXG4gICAgICBtb3VudE9wdGlvbnM6IFwibmZzdmVycz00LjEscnNpemU9MTA0ODU3Nix3c2l6ZT0xMDQ4NTc2LGhhcmQsdGltZW89NjAwLHJldHJhbnM9MlwiXG4gICAgfV1cbiAgICBjZm5Qcm9qZWN0LmxvZ3NDb25maWcgPSB7XG4gICAgICBjbG91ZFdhdGNoTG9nczoge1xuICAgICAgICBzdGF0dXM6IFwiRU5BQkxFRFwiXG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gVHJpZ2dlcnMgdGhlIENvZGVCdWlsZCBwcm9qZWN0IHRvIGluc3RhbGwgdGhlIHB5dGhvbiBwYWNrYWdlcyBhbmQgbW9kZWwgdG8gdGhlIEVGUyBmaWxlIHN5c3RlbVxuICAgIGNvbnN0IHRyaWdnZXJCdWlsZFByb2plY3QgPSBuZXcgY3IuQXdzQ3VzdG9tUmVzb3VyY2UodGhpcywgJ1RyaWdnZXJDb2RlQnVpbGQnLCB7XG4gICAgICBvbkNyZWF0ZToge1xuICAgICAgICBzZXJ2aWNlOiAnQ29kZUJ1aWxkJyxcbiAgICAgICAgYWN0aW9uOiAnc3RhcnRCdWlsZCcsXG4gICAgICAgIHBhcmFtZXRlcnM6IHtcbiAgICAgICAgICBwcm9qZWN0TmFtZTogY29kZUJ1aWxkUHJvamVjdC5wcm9qZWN0TmFtZVxuICAgICAgICB9LFxuICAgICAgICBwaHlzaWNhbFJlc291cmNlSWQ6IGNyLlBoeXNpY2FsUmVzb3VyY2VJZC5mcm9tUmVzcG9uc2UoJ2J1aWxkLmlkJyksXG4gICAgICB9LFxuICAgICAgcG9saWN5OiBjci5Bd3NDdXN0b21SZXNvdXJjZVBvbGljeS5mcm9tU2RrQ2FsbHMoeyByZXNvdXJjZXM6IGNyLkF3c0N1c3RvbVJlc291cmNlUG9saWN5LkFOWV9SRVNPVVJDRSB9KVxuICAgIH0pO1xuXG4gICAgLy8gQ3JlYXRlIGRlcGVuZGVuY3QgYmV0d2VlbiBFRlMgYW5kIENvZGVidWlsZFxuICAgIGNvZGVCdWlsZFByb2plY3Qubm9kZS5hZGREZXBlbmRlbmN5KEVmc0FjY2Vzc1BvaW50KTtcblxuICAgIC8vIE91dHB1dCBMYW1iZGEgZnVuY3Rpb24gbmFtZS5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnTGFtYmRhRnVuY3Rpb25OYW1lJywgeyB2YWx1ZTogZXhlY3V0ZUluZmVyZW5jZUZ1bmN0aW9uLmZ1bmN0aW9uTmFtZSB9KTtcbiAgfVxufVxuXG5jb25zdCBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuXG52YXIgcHJvcHM6IExhbWJkYUVGU01MU3RhY2tQcm9wcyA9IHtcbiAgaW5zdGFsbFBhY2thZ2VzOiB1bmRlZmluZWQsXG4gIGVudjoge1xuICAgIHJlZ2lvbjogJ3VzLWVhc3QtMSdcbiAgfVxufVxuXG5uZXcgTGFtYmRhRUZTTUxTdGFjayhhcHAsICdMYW1iZGFFRlNNTERlbW8nLCBwcm9wcyk7XG5hcHAuc3ludGgoKTtcbiJdfQ==