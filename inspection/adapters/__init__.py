"""adapters —— domain 与外界之间的唯一通道。

boto3、文件读写、时钟都只能出现在这一层。domain 层任何模块都不得 import 本包。
"""
